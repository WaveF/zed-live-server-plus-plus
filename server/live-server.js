#!/usr/bin/env node
/*
 * Live Server++ for Zed
 *
 * A single, dependency-free Node.js process that plays two roles:
 *
 *   1. A Language Server (LSP over stdio). Zed sends us `textDocument/didOpen`
 *      and `textDocument/didChange` for every HTML / CSS / JavaScript buffer,
 *      which gives us the *unsaved* contents of the editor. We also expose
 *      code actions ("Go Live", "Open in Browser", "Stop Server") that act as
 *      the start / stop controls, since Zed extensions have no status bar API.
 *
 *   2. A static HTTP server with a WebSocket endpoint. Requests for files that
 *      are open in Zed are answered with the in-memory (possibly unsaved)
 *      contents. Every change is pushed to connected browsers, which patch the
 *      DOM in place (HTML), swap stylesheets (CSS) or reload (everything else).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const childProcess = require('child_process');

const SERVER_NAME = 'Live Server++';
const INTERNAL_PREFIX = '/__live_server_pp__/';
const WS_PATH = INTERNAL_PREFIX + 'ws';
const CLIENT_SCRIPT_PATH = INTERNAL_PREFIX + 'client.js';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const IS_WINDOWS = process.platform === 'win32';

const COMMANDS = {
  start: 'liveServerPlusPlus.start',
  stop: 'liveServerPlusPlus.stop',
  open: 'liveServerPlusPlus.openInBrowser',
};

const DEFAULT_CONFIG = Object.freeze({
  port: 5555, // 0 = random free port
  host: '127.0.0.1',
  root: './',
  indexFile: 'index.html',
  timeout: 300, // debounce (ms) before pushing an editor change to the browser
  browser: 'default', // "default" | "chrome" | "firefox" | "microsoft-edge" | <app/command> | null
  reloadingStrategy: 'hot', // "hot" | "partial-reload" | "reload"
  autoStart: false, // start the HTTP server as soon as the language server starts
  openBrowserOnStart: true, // open the browser when the server is started from a code action
  watchFiles: true, // also react to changes on disk (files that are not open in Zed)
  ignore: ['**/node_modules/**', '**/.git/**'], // globs (relative to root) ignored by the disk watcher
});

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
};

const INJECTABLE_EXTENSIONS = new Set(['.html', '.htm', '.xhtml']);

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function log(...args) {
  // stdout is reserved for the LSP protocol; Zed shows stderr in the LSP log.
  process.stderr.write(`[${SERVER_NAME}] ${args.join(' ')}\n`);
}

function mimeType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function isInjectable(filePath) {
  return INJECTABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isCss(filePath) {
  return path.extname(filePath).toLowerCase() === '.css';
}

/** Normalises a path so it can be used as a map key / compared. */
function normalizePath(p) {
  const resolved = path.resolve(p);
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

function uriToPath(uri) {
  try {
    return url.fileURLToPath(uri);
  } catch (_) {
    return null;
  }
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

/** Converts a tiny glob dialect (`**`, `*`, `?`) to a RegExp. */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$', IS_WINDOWS ? 'i' : '');
}

function mergeConfig(...sources) {
  const config = Object.assign({}, DEFAULT_CONFIG);
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    // Accept both a flat object and one nested under a namespace key.
    const flat = source.liveServer || source['liveServer++'] || source.liveServerPlusPlus || source;
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (Object.prototype.hasOwnProperty.call(flat, key)) config[key] = flat[key];
    }
  }

  const port = Number(config.port);
  config.port = Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_CONFIG.port;
  const timeout = Number(config.timeout);
  config.timeout = Number.isFinite(timeout) && timeout >= 0 ? timeout : DEFAULT_CONFIG.timeout;
  if (!['hot', 'partial-reload', 'reload'].includes(config.reloadingStrategy)) {
    config.reloadingStrategy = DEFAULT_CONFIG.reloadingStrategy;
  }
  if (typeof config.root !== 'string' || !config.root) config.root = DEFAULT_CONFIG.root;
  if (typeof config.indexFile !== 'string' || !config.indexFile) config.indexFile = DEFAULT_CONFIG.indexFile;
  if (typeof config.host !== 'string' || !config.host) config.host = DEFAULT_CONFIG.host;
  if (!Array.isArray(config.ignore)) config.ignore = DEFAULT_CONFIG.ignore;
  return config;
}

// ---------------------------------------------------------------------------
// Minimal WebSocket (RFC 6455) server-side connection
// ---------------------------------------------------------------------------

class WebSocketConnection {
  constructor(socket, onMessage, onClose) {
    this.socket = socket;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
    this.watchList = [];

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._finish());
    socket.on('error', () => this._finish());
  }

  send(text) {
    if (this.closed) return;
    this._writeFrame(0x1, Buffer.from(text, 'utf8'));
  }

  close(code = 1000) {
    if (this.closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this._writeFrame(0x8, payload);
    this.socket.end();
    this._finish();
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.onClose(this);
  }

  _writeFrame(opcode, payload) {
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (_) {
      this._finish();
    }
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (length > 16 * 1024 * 1024) return this.close(1009);
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;

      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (masked) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= this.buffer[maskOffset + (i % 4)];
      }
      this.buffer = this.buffer.subarray(offset + length);

      switch (opcode) {
        case 0x0: // continuation
        case 0x1: // text
        case 0x2: // binary
          this.fragments.push(payload);
          if (fin) {
            const message = Buffer.concat(this.fragments).toString('utf8');
            this.fragments = [];
            try {
              this.onMessage(this, message);
            } catch (err) {
              log('WebSocket message error:', err && err.message);
            }
          }
          break;
        case 0x8: // close
          this.close();
          return;
        case 0x9: // ping
          this._writeFrame(0xa, payload);
          break;
        default: // pong / unknown
          break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Live server
// ---------------------------------------------------------------------------

class LiveServer {
  constructor(lsp) {
    this.lsp = lsp;
    this.workspaceRoot = process.cwd();
    this.config = mergeConfig();
    this.documents = new Map(); // normalized path -> { uri, path, text, version }
    this.server = null;
    this.port = null;
    this.clients = new Set();
    this.pending = new Map(); // normalized path -> debounce timer
    this.watcher = null;
    this.clientScript = null;
    this.ignoreMatchers = [];
  }

  // ----- state -------------------------------------------------------------

  get running() {
    return !!(this.server && this.server.listening);
  }

  get serveRoot() {
    return path.resolve(this.workspaceRoot, this.config.root);
  }

  get origin() {
    const host = ['0.0.0.0', '::', ''].includes(this.config.host) ? 'localhost' : this.config.host;
    const formatted = host.includes(':') ? `[${host}]` : host;
    return `http://${formatted}:${this.port}`;
  }

  setWorkspaceRoot(root) {
    if (!root) return;
    // Zed may open a single file as a worktree: serve its folder.
    try {
      if (fs.statSync(root).isFile()) root = path.dirname(root);
    } catch (_) {
      /* keep as is */
    }
    this.workspaceRoot = root;
  }

  async applyConfig(config) {
    const previous = this.config;
    this.config = config;
    this.ignoreMatchers = config.ignore.map(globToRegExp);
    const needsRestart =
      this.running &&
      (previous.port !== config.port ||
        previous.host !== config.host ||
        path.resolve(this.workspaceRoot, previous.root) !== this.serveRoot ||
        previous.watchFiles !== config.watchFiles);
    if (needsRestart) {
      log('Configuration changed, restarting server.');
      await this.stop({ silent: true });
      await this.start({ openBrowser: false });
    }
  }

  // ----- documents (fed by the LSP side) -----------------------------------

  openDocument(uri, text, version) {
    const filePath = uriToPath(uri);
    if (!filePath) return;
    this.documents.set(normalizePath(filePath), { uri, path: filePath, text, version });
  }

  changeDocument(uri, text, version) {
    const filePath = uriToPath(uri);
    if (!filePath) return;
    const key = normalizePath(filePath);
    const doc = this.documents.get(key);
    if (doc && doc.text === text) return;
    this.documents.set(key, { uri, path: filePath, text, version });
    this.scheduleChange(filePath, 'editor');
  }

  closeDocument(uri) {
    const filePath = uriToPath(uri);
    if (!filePath) return;
    const key = normalizePath(filePath);
    const doc = this.documents.get(key);
    this.documents.delete(key);
    // The buffer may have been closed without saving: re-sync with the disk.
    if (doc) {
      fs.readFile(filePath, 'utf8', (err, diskText) => {
        if (!err && diskText !== doc.text) this.scheduleChange(filePath, 'disk');
      });
    }
  }

  // ----- lifecycle ---------------------------------------------------------

  async start({ openBrowser = this.config.openBrowserOnStart, targetPath = null } = {}) {
    if (this.running) {
      if (openBrowser) await this.openInBrowser(targetPath);
      return;
    }

    const root = this.serveRoot;
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      this.lsp.showMessage(1, `${SERVER_NAME}: root folder "${root}" does not exist.`);
      return;
    }

    const server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        log('Request failed:', err && err.stack);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('500 Internal Server Error');
      });
    });
    server.on('upgrade', (req, socket) => this.handleUpgrade(req, socket));
    server.on('clientError', (_err, socket) => socket.destroy());

    const port = await this.listen(server, this.config.port);
    if (port === null) {
      this.lsp.showMessage(
        1,
        `${SERVER_NAME}: could not start the server (port ${this.config.port} and the following ports are in use).`,
      );
      return;
    }
    this.server = server;
    this.port = port;
    this.startWatcher();

    const note = this.config.port !== 0 && port !== this.config.port ? ` (port ${this.config.port} was in use)` : '';
    log(`Serving ${root} at ${this.origin}/${note}`);
    this.lsp.showMessage(3, `${SERVER_NAME} is live at ${this.origin}/${note}`);

    if (openBrowser) await this.openInBrowser(targetPath);
  }

  /** Tries the configured port, then the next 20 ports. Resolves to the bound port or null. */
  listen(server, firstPort) {
    const host = this.config.host;
    const attempts = firstPort === 0 ? 1 : 21;
    return new Promise((resolve) => {
      let attempt = 0;
      const tryListen = () => {
        const port = firstPort === 0 ? 0 : firstPort + attempt;
        if (port > 65535) return resolve(null);
        const onError = (err) => {
          server.removeListener('listening', onListening);
          attempt++;
          if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && attempt < attempts) {
            tryListen();
          } else {
            log('listen error:', err.message);
            resolve(null);
          }
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve(server.address().port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      };
      tryListen();
    });
  }

  async stop({ silent = false } = {}) {
    if (!this.running) {
      if (!silent) this.lsp.showMessage(3, `${SERVER_NAME}: server is not running.`);
      return;
    }
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.stopWatcher();
    for (const client of this.clients) client.close(1001);
    this.clients.clear();
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => {
      server.close(() => resolve());
      if (server.closeAllConnections) server.closeAllConnections();
    });
    log('Server stopped.');
    if (!silent) this.lsp.showMessage(3, `${SERVER_NAME}: server stopped (port ${this.port}).`);
    this.port = null;
  }

  // ----- browser -----------------------------------------------------------

  /** Returns the URL path for a file under the serve root, or null if it's outside of it. */
  urlPathFor(filePath) {
    const root = this.serveRoot;
    if (!filePath) return '/';
    const absolute = path.resolve(filePath);
    if (!isInside(normalizePath(absolute), normalizePath(root))) return null;
    const rel = path.relative(root, absolute).split(path.sep).map(encodeURIComponent).join('/');
    return '/' + rel;
  }

  async openInBrowser(targetPath) {
    if (!this.running) return;
    let urlPath = '/';
    if (targetPath && isInjectable(targetPath)) {
      urlPath = this.urlPathFor(targetPath);
      if (urlPath === null) {
        this.lsp.showMessage(
          2,
          `${SERVER_NAME}: "${targetPath}" is outside of the server root (${this.serveRoot}); opening the root instead.`,
        );
        urlPath = '/';
      }
    }
    const target = this.origin + urlPath;
    const browser = this.config.browser;
    if (browser === null || browser === false || browser === 'none' || browser === 'null') return;

    if (!browser || browser === 'default') {
      // Let Zed open the URL: it knows the user's default browser (and works for remote projects).
      const ok = await this.lsp.showDocument(target);
      if (ok) return;
    }
    launchBrowser(browser, target);
  }

  // ----- change propagation ------------------------------------------------

  scheduleChange(filePath, source) {
    if (!this.running) return;
    const key = normalizePath(filePath);
    clearTimeout(this.pending.get(key));
    const delay = source === 'editor' ? this.config.timeout : Math.max(100, Math.min(this.config.timeout, 300));
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        this.broadcastChange(filePath);
      }, delay),
    );
  }

  broadcastChange(filePath) {
    if (!this.running || this.clients.size === 0) return;
    const urlPath = this.urlPathFor(filePath);
    // Files outside of the served folder can't be loaded by the pages.
    if (urlPath === null) return;
    const fileKey = normalizePath(filePath);

    if (isCss(filePath)) {
      this.send(this.clients, { action: 'refreshcss', data: { fileName: urlPath } });
      return;
    }

    if (isInjectable(filePath)) {
      const strategy = this.config.reloadingStrategy;
      const viewers = [...this.clients].filter((client) =>
        client.watchList.some((p) => {
          const resolved = this.resolveUrlPath(p);
          return resolved && normalizePath(resolved) === fileKey;
        }),
      );
      if (viewers.length === 0) return;
      if (strategy === 'reload') {
        this.send(viewers, { action: 'reload', data: { fileName: urlPath } });
      } else {
        const doc = this.documents.get(fileKey);
        const dom = doc ? doc.text : readTextSafe(filePath);
        if (dom === null) return this.send(viewers, { action: 'reload', data: { fileName: urlPath } });
        this.send(viewers, { action: strategy, data: { fileName: urlPath, dom } });
      }
      return;
    }

    this.send(this.clients, { action: 'reload', data: { fileName: urlPath } });
  }

  send(clients, message) {
    const payload = JSON.stringify(message);
    for (const client of clients) client.send(payload);
  }

  // ----- disk watcher ------------------------------------------------------

  startWatcher() {
    this.stopWatcher();
    if (!this.config.watchFiles) return;
    const root = this.serveRoot;
    try {
      this.watcher = fs.watch(root, { recursive: true }, (_event, fileName) => {
        if (!fileName) return;
        const rel = String(fileName).split(path.sep).join('/');
        if (this.ignoreMatchers.some((re) => re.test(rel))) return;
        const absolute = path.join(root, String(fileName));
        // Open buffers are the source of truth – saving them must not trigger a reload.
        const doc = this.documents.get(normalizePath(absolute));
        if (doc) {
          const disk = readTextSafe(absolute);
          if (disk === null || disk === doc.text) return;
        }
        this.scheduleChange(absolute, 'disk');
      });
      this.watcher.on('error', (err) => {
        log('watcher error:', err.message);
        this.stopWatcher();
      });
    } catch (err) {
      log('Disk watching is unavailable:', err.message);
      this.watcher = null;
    }
  }

  stopWatcher() {
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch (_) {
        /* ignore */
      }
      this.watcher = null;
    }
  }

  // ----- HTTP --------------------------------------------------------------

  /**
   * Maps a URL pathname (as seen by a browser) to the file it displays, resolving
   * directories to their index file. Returns null when it's outside of the root.
   */
  resolveUrlPath(pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname || '/');
    } catch (_) {
      return null;
    }
    if (decoded.includes('\0')) return null;
    const root = this.serveRoot;
    let filePath = path.join(root, path.normalize(decoded).replace(/^([/\\])+/, ''));
    if (!isInside(normalizePath(filePath), normalizePath(root))) return null;

    if (decoded.endsWith('/') || this.isDirectory(filePath)) {
      filePath = path.join(filePath, this.config.indexFile);
    }
    return filePath;
  }

  isDirectory(p) {
    try {
      return fs.statSync(p).isDirectory();
    } catch (_) {
      return false;
    }
  }

  async handleRequest(req, res) {
    const parsed = new URL(req.url || '/', 'http://localhost');
    const pathname = parsed.pathname;

    res.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
    res.setHeader('x-powered-by', SERVER_NAME);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      return res.end();
    }

    if (pathname === CLIENT_SCRIPT_PATH) {
      res.writeHead(200, { 'content-type': MIME_TYPES['.js'] });
      return res.end(req.method === 'HEAD' ? undefined : this.getClientScript());
    }

    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch (_) {
      return this.sendError(res, 400, 'Bad Request');
    }
    const root = this.serveRoot;
    const requested = path.join(root, path.normalize(decoded).replace(/^([/\\])+/, ''));
    if (!isInside(normalizePath(requested), normalizePath(root))) {
      return this.sendError(res, 403, 'Forbidden');
    }

    // Directory: redirect to a trailing slash so relative URLs work, then serve the index file.
    if (this.isDirectory(requested)) {
      if (!pathname.endsWith('/')) {
        res.writeHead(301, { location: pathname + '/' + parsed.search });
        return res.end();
      }
      const indexPath = path.join(requested, this.config.indexFile);
      if (this.documents.has(normalizePath(indexPath)) || fs.existsSync(indexPath)) {
        return this.serveFile(req, res, indexPath);
      }
      return this.serveDirectoryListing(req, res, requested, pathname);
    }

    return this.serveFile(req, res, requested);
  }

  serveFile(req, res, filePath) {
    const doc = this.documents.get(normalizePath(filePath));
    const contentType = mimeType(filePath);

    if (isInjectable(filePath)) {
      const text = doc ? doc.text : readTextSafe(filePath);
      if (text === null) return this.sendError(res, 404, 'Not Found', filePath);
      const body = Buffer.from(injectClient(text), 'utf8');
      res.writeHead(200, { 'content-type': contentType, 'content-length': body.length });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }

    if (doc) {
      // Unsaved (in-memory) content straight from the editor.
      const body = Buffer.from(doc.text, 'utf8');
      res.writeHead(200, { 'content-type': contentType, 'content-length': body.length });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }

    return new Promise((resolve) => {
      fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
          this.sendError(res, 404, 'Not Found', filePath);
          return resolve();
        }
        const headers = { 'content-type': contentType, 'accept-ranges': 'bytes' };
        let start = 0;
        let end = stat.size - 1;
        let status = 200;
        const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (range && stat.size > 0) {
          if (range[1] === '' && range[2] !== '') {
            start = Math.max(0, stat.size - Number(range[2]));
          } else {
            start = Number(range[1] || 0);
            if (range[2] !== '') end = Math.min(end, Number(range[2]));
          }
          if (start > end || start >= stat.size) {
            res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
            res.end();
            return resolve();
          }
          status = 206;
          headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
        }
        headers['content-length'] = stat.size === 0 ? 0 : end - start + 1;
        res.writeHead(status, headers);
        if (req.method === 'HEAD' || stat.size === 0) {
          res.end();
          return resolve();
        }
        const stream = fs.createReadStream(filePath, { start, end });
        stream.on('error', () => res.destroy());
        stream.on('close', resolve);
        stream.pipe(res);
      });
    });
  }

  serveDirectoryListing(req, res, dirPath, pathname) {
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (_) {
      return this.sendError(res, 404, 'Not Found', dirPath);
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const items = entries
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => {
        const name = e.name + (e.isDirectory() ? '/' : '');
        return `<li><a href="${encodeURIComponent(e.name)}${e.isDirectory() ? '/' : ''}">${escapeHtml(name)}</a></li>`;
      });
    if (pathname !== '/') items.unshift('<li><a href="../">../</a></li>');
    const html =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Index of ${escapeHtml(pathname)}</title>` +
      `<style>body{font:14px/1.6 system-ui,sans-serif;margin:2em;color:#333}a{text-decoration:none;color:#0366d6}` +
      `a:hover{text-decoration:underline}ul{list-style:none;padding:0}h1{font-weight:500}</style></head>` +
      `<body><h1>Index of ${escapeHtml(pathname)}</h1><ul>${items.join('')}</ul></body></html>`;
    const body = Buffer.from(injectClient(html), 'utf8');
    res.writeHead(200, { 'content-type': MIME_TYPES['.html'], 'content-length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  sendError(res, status, message, filePath) {
    const detail = filePath ? `<p><code>${escapeHtml(path.relative(this.serveRoot, filePath))}</code></p>` : '';
    const html =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${status} ${escapeHtml(message)}</title></head>` +
      `<body style="font:14px system-ui,sans-serif;margin:2em"><h1>${status} ${escapeHtml(message)}</h1>${detail}</body></html>`;
    // Inject the client so the page recovers automatically once the file exists.
    const body = Buffer.from(injectClient(html), 'utf8');
    res.writeHead(status, { 'content-type': MIME_TYPES['.html'], 'content-length': body.length });
    res.end(body);
  }

  getClientScript() {
    if (this.clientScript === null) {
      this.clientScript = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');
    }
    return this.clientScript;
  }

  // ----- WebSocket ---------------------------------------------------------

  handleUpgrade(req, socket) {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    const key = req.headers['sec-websocket-key'];
    if (pathname !== WS_PATH || !key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const client = new WebSocketConnection(
      socket,
      (conn, message) => {
        const data = JSON.parse(message);
        if (data && data.watchList) {
          conn.watchList = (Array.isArray(data.watchList) ? data.watchList : [data.watchList]).map(String);
        }
      },
      (conn) => this.clients.delete(conn),
    );
    this.clients.add(client);
    client.send(JSON.stringify({ action: 'connected' }));
  }
}

function readTextSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }
}

/** Injects the live reload client into an HTML document. */
function injectClient(html) {
  const snippet =
    `\n<!-- Code injected by ${SERVER_NAME} -->\n` +
    `<script data-live-server-ignore="true" src="${CLIENT_SCRIPT_PATH}"></script>\n`;
  const headClose = html.search(/<\/head\s*>/i);
  if (headClose !== -1) return html.slice(0, headClose) + snippet + html.slice(headClose);
  const bodyClose = html.search(/<\/body\s*>/i);
  if (bodyClose !== -1) return html.slice(0, bodyClose) + snippet + html.slice(bodyClose);
  return html + snippet;
}

const BROWSERS = {
  darwin: { chrome: 'Google Chrome', firefox: 'Firefox', 'microsoft-edge': 'Microsoft Edge', safari: 'Safari' },
  win32: { chrome: 'chrome', firefox: 'firefox', 'microsoft-edge': 'msedge' },
  linux: {
    chrome: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
    firefox: ['firefox'],
    'microsoft-edge': ['microsoft-edge', 'microsoft-edge-stable'],
  },
};

function launchBrowser(browser, target) {
  const spawn = (cmd, args) => {
    const child = childProcess.spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (err) => log(`Could not launch "${cmd}":`, err.message));
    child.unref();
    return child;
  };
  const name = !browser || browser === 'default' ? null : String(browser);

  if (process.platform === 'darwin') {
    const app = name && (BROWSERS.darwin[name] || name);
    return spawn('open', app ? ['-a', app, target] : [target]);
  }
  if (IS_WINDOWS) {
    const app = name && (BROWSERS.win32[name] || name);
    return spawn('cmd', app ? ['/c', 'start', '""', app, target] : ['/c', 'start', '""', target]);
  }
  // Linux / BSD: try the candidates in order.
  const candidates = name ? BROWSERS.linux[name] || [name] : ['xdg-open'];
  const tryNext = (i) => {
    if (i >= candidates.length) return log('No browser could be launched for', target);
    const child = childProcess.spawn(candidates[i], [target], { detached: true, stdio: 'ignore' });
    child.on('error', () => tryNext(i + 1));
    child.unref();
  };
  tryNext(0);
}

// ---------------------------------------------------------------------------
// Language Server Protocol (JSON-RPC over stdio)
// ---------------------------------------------------------------------------

class LanguageServer {
  constructor(input, output) {
    this.output = output;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pendingRequests = new Map();
    this.clientCapabilities = {};
    this.shuttingDown = false;
    this.live = new LiveServer(this);
    this.initOptions = null;
    this.workspaceSettings = null;

    input.on('data', (chunk) => this.onData(chunk));
    input.on('end', () => this.exit(this.shuttingDown ? 0 : 1));
  }

  // ----- transport ---------------------------------------------------------

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Corrupt header – drop it.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString('utf8');
      this.buffer = this.buffer.subarray(start + length);
      let message;
      try {
        message = JSON.parse(body);
      } catch (err) {
        log('Invalid JSON-RPC message:', err.message);
        continue;
      }
      this.dispatch(message).catch((err) => log('Handler failed:', err && err.stack));
    }
  }

  write(message) {
    message.jsonrpc = '2.0';
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.output.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.output.write(body);
  }

  respond(id, result) {
    this.write({ id, result: result === undefined ? null : result });
  }

  respondError(id, code, message) {
    this.write({ id, error: { code, message } });
  }

  notify(method, params) {
    this.write({ method, params });
  }

  request(method, params, timeoutMs = 10000) {
    const id = `lspp-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  showMessage(type, message) {
    this.notify('window/showMessage', { type, message });
  }

  async showDocument(uri) {
    const supported =
      this.clientCapabilities.window && this.clientCapabilities.window.showDocument && this.clientCapabilities.window.showDocument.support;
    if (!supported) return false;
    try {
      const result = await this.request('window/showDocument', { uri, external: true, takeFocus: true });
      return !!(result && result.success);
    } catch (err) {
      log('window/showDocument failed:', err.message);
      return false;
    }
  }

  // ----- dispatch ----------------------------------------------------------

  async dispatch(message) {
    // Response to one of our requests.
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
      return;
    }

    const { id, method, params } = message;
    const isRequest = id !== undefined;

    try {
      switch (method) {
        case 'initialize':
          return this.respond(id, this.initialize(params || {}));
        case 'initialized':
          return this.initialized();
        case 'shutdown':
          this.shuttingDown = true;
          await this.live.stop({ silent: true });
          return this.respond(id, null);
        case 'exit':
          return this.exit(this.shuttingDown ? 0 : 1);
        case 'workspace/didChangeConfiguration':
          this.workspaceSettings = params && params.settings;
          return this.live.applyConfig(mergeConfig(this.initOptions, this.workspaceSettings));
        case 'textDocument/didOpen': {
          const doc = params.textDocument;
          return this.live.openDocument(doc.uri, doc.text, doc.version);
        }
        case 'textDocument/didChange': {
          const changes = params.contentChanges || [];
          // We advertise full document sync, so the last change holds the whole text.
          const last = changes[changes.length - 1];
          if (last && last.range === undefined) {
            this.live.changeDocument(params.textDocument.uri, last.text, params.textDocument.version);
          }
          return;
        }
        case 'textDocument/didClose':
          return this.live.closeDocument(params.textDocument.uri);
        case 'textDocument/didSave':
          return;
        case 'textDocument/codeAction':
          return this.respond(id, this.codeActions(params));
        case 'workspace/executeCommand':
          return this.respond(id, await this.executeCommand(params));
        default:
          if (isRequest) {
            if (method === '$/cancelRequest') return;
            return this.respondError(id, -32601, `Unhandled method ${method}`);
          }
      }
    } catch (err) {
      log(`Error handling ${method}:`, err && err.stack);
      if (isRequest) this.respondError(id, -32603, String((err && err.message) || err));
    }
  }

  initialize(params) {
    this.clientCapabilities = params.capabilities || {};
    const folder =
      (params.workspaceFolders && params.workspaceFolders[0] && uriToPath(params.workspaceFolders[0].uri)) ||
      (params.rootUri && uriToPath(params.rootUri)) ||
      params.rootPath ||
      process.cwd();
    this.live.setWorkspaceRoot(folder);
    this.initOptions = params.initializationOptions || null;
    this.live.config = mergeConfig(this.initOptions);
    this.live.ignoreMatchers = this.live.config.ignore.map(globToRegExp);

    if (params.processId) {
      // Exit if the editor dies without shutting us down.
      const parent = params.processId;
      setInterval(() => {
        try {
          process.kill(parent, 0);
        } catch (err) {
          if (err.code === 'ESRCH') this.exit(1);
        }
      }, 5000).unref();
    }

    return {
      capabilities: {
        textDocumentSync: { openClose: true, change: 1 /* Full */, save: false },
        codeActionProvider: true,
        executeCommandProvider: { commands: Object.values(COMMANDS) },
      },
      serverInfo: { name: 'live-server-plus-plus', version: '0.1.0' },
    };
  }

  async initialized() {
    log(`Workspace: ${this.live.workspaceRoot}`);
    if (this.live.config.autoStart) {
      await this.live.start({ openBrowser: false });
    }
  }

  codeActions(params) {
    const only = params.context && params.context.only;
    // Only respond to the user's code action menu, never to "code actions on format".
    if (only && only.length) return [];

    const uri = params.textDocument && params.textDocument.uri;
    const filePath = uri ? uriToPath(uri) : null;
    const actions = [];
    const command = (title, cmd) => ({ title, command: { title, command: cmd, arguments: [uri] } });

    if (!this.live.running) {
      actions.push(command(`${SERVER_NAME}: Go Live (start server)`, COMMANDS.start));
    } else {
      const target = filePath && isInjectable(filePath) ? this.live.urlPathFor(filePath) : '/';
      const label = target === null ? '/' : decodeURI(target);
      actions.push(command(`${SERVER_NAME}: Open ${label} in browser`, COMMANDS.open));
      actions.push(command(`${SERVER_NAME}: Stop server (port ${this.live.port})`, COMMANDS.stop));
    }
    return actions;
  }

  async executeCommand(params) {
    const arg = params.arguments && params.arguments[0];
    const filePath = typeof arg === 'string' ? uriToPath(arg) : null;
    switch (params.command) {
      case COMMANDS.start:
        await this.live.start({ targetPath: filePath });
        return null;
      case COMMANDS.open:
        if (!this.live.running) await this.live.start({ openBrowser: true, targetPath: filePath });
        else await this.live.openInBrowser(filePath);
        return null;
      case COMMANDS.stop:
        await this.live.stop();
        return null;
      default:
        throw new Error(`Unknown command ${params.command}`);
    }
  }

  exit(code) {
    try {
      if (this.live.server) this.live.server.close();
    } catch (_) {
      /* ignore */
    }
    process.exit(code);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  process.on('uncaughtException', (err) => log('Uncaught exception:', err && err.stack));
  process.on('unhandledRejection', (err) => log('Unhandled rejection:', err && (err.stack || err)));
  new LanguageServer(process.stdin, process.stdout);
}

module.exports = { LiveServer, LanguageServer, mergeConfig, injectClient, globToRegExp };
