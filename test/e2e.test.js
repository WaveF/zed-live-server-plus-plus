/*
 * End-to-end test for server/live-server.js
 *   node --test test/
 *
 * Spawns the server as Zed would (LSP over stdio), then checks the HTTP server,
 * unsaved-content serving, script injection, WebSocket broadcasts and code actions.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SERVER = path.join(__dirname, '..', 'server', 'live-server.js');

class LspClient {
  constructor(cwd) {
    this.proc = spawn(process.execPath, [SERVER], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.requestsFromServer = [];
    this.stderr = '';
    this.proc.stderr.on('data', (d) => (this.stderr += d));
    this.proc.stdout.on('data', (chunk) => this.onData(chunk));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      const len = Number(/Content-Length: (\d+)/i.exec(this.buffer.subarray(0, end).toString())[1]);
      if (this.buffer.length < end + 4 + len) return;
      const msg = JSON.parse(this.buffer.subarray(end + 4, end + 4 + len).toString());
      this.buffer = this.buffer.subarray(end + 4 + len);
      if (msg.method && msg.id !== undefined) {
        this.requestsFromServer.push(msg);
        // Pretend we're Zed and successfully opened the URL externally.
        this.send({ id: msg.id, result: { success: true } });
      } else if (msg.method) {
        this.notifications.push(msg);
      } else {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    }
  }

  send(msg) {
    msg.jsonrpc = '2.0';
    const body = Buffer.from(JSON.stringify(msg));
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin.write(body);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  notify(method, params) {
    this.send({ method, params });
  }
}

function wsConnect(port, pathname) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__live_server_pp__/ws`);
    const messages = [];
    const waiters = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      const w = waiters.shift();
      if (w) w(msg);
      else messages.push(msg);
    };
    ws.onopen = () => {
      ws.send(JSON.stringify({ watchList: [pathname] }));
      resolve({
        ws,
        next(timeout = 3000) {
          if (messages.length) return Promise.resolve(messages.shift());
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('timeout waiting for ws message')), timeout);
            waiters.push((m) => {
              clearTimeout(t);
              res(m);
            });
          });
        },
        pending: () => messages.length,
      });
    };
    ws.onerror = reject;
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('live server end to end', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lspp-'));
  fs.mkdirSync(path.join(root, 'site', 'sub'), { recursive: true });
  const indexPath = path.join(root, 'site', 'index.html');
  const cssPath = path.join(root, 'site', 'style.css');
  const jsPath = path.join(root, 'site', 'app.js');
  fs.writeFileSync(indexPath, '<!doctype html><html><head><title>A</title></head><body><h1>Saved</h1></body></html>');
  fs.writeFileSync(cssPath, 'h1 { color: red; }');
  fs.writeFileSync(jsPath, 'console.log(1);');
  fs.writeFileSync(path.join(root, 'site', 'sub', 'page.txt'), 'hello');
  fs.writeFileSync(path.join(root, 'site', '..evil'), 'x');

  const client = new LspClient(root);
  t.after(() => {
    client.proc.kill();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const init = await client.request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(root).href,
    capabilities: { window: { showDocument: { support: true } } },
    initializationOptions: { port: 0, root: './site', timeout: 50 },
  });
  assert.strictEqual(init.capabilities.textDocumentSync.change, 1);
  assert.ok(init.capabilities.executeCommandProvider.commands.includes('liveServerPlusPlus.start'));
  client.notify('initialized', {});
  client.notify('workspace/didChangeConfiguration', { settings: { port: 0, root: './site', timeout: 50 } });

  const uri = pathToFileURL(indexPath).href;
  client.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'html', version: 1, text: fs.readFileSync(indexPath, 'utf8') },
  });

  // Code actions before start.
  let actions = await client.request('textDocument/codeAction', {
    textDocument: { uri },
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    context: { diagnostics: [] },
  });
  assert.strictEqual(actions.length, 1);
  assert.match(actions[0].title, /Go Live/);

  // Code actions on format must be ignored.
  const formatActions = await client.request('textDocument/codeAction', {
    textDocument: { uri },
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    context: { diagnostics: [], only: ['source.organizeImports'] },
  });
  assert.deepStrictEqual(formatActions, []);

  // Start via the command, as Zed would when the code action is picked.
  await client.request('workspace/executeCommand', { command: actions[0].command.command, arguments: [uri] });

  const live = client.notifications.find((n) => n.method === 'window/showMessage' && /is live at/.test(n.params.message));
  assert.ok(live, 'expected a "live" message; stderr: ' + client.stderr);
  const port = Number(/:(\d+)\//.exec(live.params.message)[1]);

  const showDoc = client.requestsFromServer.find((r) => r.method === 'window/showDocument');
  assert.ok(showDoc, 'browser should be opened via window/showDocument');
  assert.strictEqual(showDoc.params.uri, `http://127.0.0.1:${port}/index.html`);
  assert.strictEqual(showDoc.params.external, true);

  actions = await client.request('textDocument/codeAction', {
    textDocument: { uri },
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    context: { diagnostics: [] },
  });
  assert.strictEqual(actions.length, 2);
  assert.match(actions[0].title, /Open \/index\.html in browser/);
  assert.match(actions[1].title, /Stop server/);

  const base = `http://127.0.0.1:${port}`;

  // HTML is served with the injected client.
  let res = await fetch(base + '/');
  let html = await res.text();
  assert.strictEqual(res.status, 200);
  assert.match(html, /<h1>Saved<\/h1>/);
  assert.match(html, /__live_server_pp__\/client\.js"><\/script>\n<\/head>/);

  // Client script.
  res = await fetch(base + '/__live_server_pp__/client.js');
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /__liveServerPlusPlus__/);

  // Directory redirect + listing.
  res = await fetch(base + '/sub', { redirect: 'manual' });
  assert.strictEqual(res.status, 301);
  assert.strictEqual(res.headers.get('location'), '/sub/');
  res = await fetch(base + '/sub/');
  assert.match(await res.text(), /page\.txt/);

  // Traversal is blocked.
  res = await fetch(base + '/%2e%2e/%2e%2e/etc/passwd');
  assert.ok([403, 404].includes(res.status));
  res = await fetch(base + '/..evil');
  assert.strictEqual(res.status, 200, 'names starting with .. inside the root are fine');

  // Static file + range.
  res = await fetch(base + '/sub/page.txt', { headers: { range: 'bytes=1-3' } });
  assert.strictEqual(res.status, 206);
  assert.strictEqual(await res.text(), 'ell');

  // 404
  res = await fetch(base + '/missing.png');
  assert.strictEqual(res.status, 404);

  // WebSocket: a client viewing /index.html.
  const viewer = await wsConnect(port, '/');
  assert.deepStrictEqual(await viewer.next(), { action: 'connected' });
  const other = await wsConnect(port, '/sub/other.html');
  await other.next();
  await sleep(50);

  // Unsaved HTML change -> hot update with the new DOM, only for the viewer.
  const unsaved = '<!doctype html><html><head><title>A</title></head><body><h1>Unsaved!</h1></body></html>';
  client.notify('textDocument/didChange', {
    textDocument: { uri, version: 2 },
    contentChanges: [{ text: unsaved }],
  });
  let msg = await viewer.next();
  assert.strictEqual(msg.action, 'hot');
  assert.strictEqual(msg.data.dom, unsaved);
  assert.strictEqual(msg.data.fileName, '/index.html');
  await sleep(100);
  assert.strictEqual(other.pending(), 0, 'pages not showing index.html are not notified');

  // The HTTP server serves the unsaved content too.
  html = await (await fetch(base + '/index.html')).text();
  assert.match(html, /Unsaved!/);

  // Debounce: rapid changes produce a single message with the latest text.
  for (let i = 0; i < 5; i++) {
    client.notify('textDocument/didChange', {
      textDocument: { uri, version: 3 + i },
      contentChanges: [{ text: unsaved.replace('Unsaved!', 'v' + i) }],
    });
  }
  msg = await viewer.next();
  assert.match(msg.data.dom, /v4/);
  await sleep(150);
  assert.strictEqual(viewer.pending(), 0);

  // Unsaved CSS change -> refreshcss for everyone, served from memory.
  const cssUri = pathToFileURL(cssPath).href;
  client.notify('textDocument/didOpen', {
    textDocument: { uri: cssUri, languageId: 'css', version: 1, text: 'h1 { color: red; }' },
  });
  client.notify('textDocument/didChange', {
    textDocument: { uri: cssUri, version: 2 },
    contentChanges: [{ text: 'h1 { color: blue; }' }],
  });
  assert.strictEqual((await viewer.next()).action, 'refreshcss');
  assert.strictEqual((await other.next()).action, 'refreshcss');
  res = await fetch(base + '/style.css');
  assert.strictEqual(await res.text(), 'h1 { color: blue; }');
  assert.match(res.headers.get('content-type'), /text\/css/);

  // JS change -> full reload.
  const jsUri = pathToFileURL(jsPath).href;
  client.notify('textDocument/didOpen', {
    textDocument: { uri: jsUri, languageId: 'javascript', version: 1, text: 'console.log(1);' },
  });
  client.notify('textDocument/didChange', {
    textDocument: { uri: jsUri, version: 2 },
    contentChanges: [{ text: 'console.log(2);' }],
  });
  assert.strictEqual((await viewer.next()).action, 'reload');
  assert.strictEqual((await other.next()).action, 'reload');

  // Disk change of a file that isn't open -> reload (fs.watch may be slow to start).
  await sleep(200);
  fs.writeFileSync(path.join(root, 'site', 'sub', 'page.txt'), 'changed on disk');
  msg = await viewer.next(5000);
  assert.strictEqual(msg.action, 'reload');
  await other.next(5000);

  // Saving an open buffer (disk == memory) must not trigger anything extra.
  await sleep(400);
  while (viewer.pending()) await viewer.next();
  while (other.pending()) await other.next();
  fs.writeFileSync(jsPath, 'console.log(2);');
  await sleep(600);
  assert.strictEqual(viewer.pending(), 0, 'saving an open file should not reload');

  // Strategy "reload" via configuration.
  client.notify('workspace/didChangeConfiguration', {
    settings: { port: 0, root: './site', timeout: 50, reloadingStrategy: 'reload' },
  });
  await sleep(50);
  client.notify('textDocument/didChange', {
    textDocument: { uri, version: 20 },
    contentChanges: [{ text: unsaved.replace('Unsaved!', 'reload me') }],
  });
  assert.strictEqual((await viewer.next()).action, 'reload');

  // Stop.
  const stop = actions.find((a) => /Stop server/.test(a.title));
  await client.request('workspace/executeCommand', { command: stop.command.command, arguments: [uri] });
  await assert.rejects(fetch(base + '/'));

  // Shutdown / exit.
  await client.request('shutdown', null);
  const exited = new Promise((r) => client.proc.on('exit', r));
  client.notify('exit', null);
  assert.strictEqual(await exited, 0);
});

test('port fallback when the configured port is busy', async (t) => {
  const net = require('node:net');
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const busy = blocker.address().port;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lspp-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<p>hi</p>');
  const client = new LspClient(root);
  t.after(() => {
    client.proc.kill();
    blocker.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await client.request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(root).href,
    capabilities: {},
    initializationOptions: { port: busy, autoStart: true },
  });
  client.notify('initialized', {});
  for (let i = 0; i < 50 && !client.notifications.length; i++) await sleep(20);
  const live = client.notifications.find((n) => /is live at/.test(n.params.message));
  assert.ok(live, client.stderr);
  const port = Number(/:(\d+)\//.exec(live.params.message)[1]);
  assert.notStrictEqual(port, busy);
  assert.match(live.params.message, /was in use/);
  // No body/head: the client is appended.
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(html, /^<p>hi<\/p>\n<!-- Code injected/);
});
