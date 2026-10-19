/*
 * Browser test for server/client.js, using headless Chrome via the DevTools protocol.
 *   CHROME_PATH=/path/to/chrome node --test test/
 * Skipped when no Chrome/Chromium is found.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SERVER = path.join(__dirname, '..', 'server', 'live-server.js');

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const r = spawnSync('which', [name], { encoding: 'utf8' });
    if (r.status === 0) return r.stdout.trim();
  }
  return null;
}

const CHROME = findChrome();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lsp(cwd) {
  const proc = spawn(process.execPath, [SERVER], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = Buffer.alloc(0);
  let id = 1;
  const pending = new Map();
  const notifications = [];
  proc.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      const len = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
      if (buffer.length < end + 4 + len) return;
      const msg = JSON.parse(buffer.subarray(end + 4, end + 4 + len).toString());
      buffer = buffer.subarray(end + 4 + len);
      if (msg.method) notifications.push(msg);
      else if (pending.has(msg.id)) pending.get(msg.id)(msg.result);
    }
  });
  const send = (msg) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }));
    proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    proc.stdin.write(body);
  };
  return {
    proc,
    notifications,
    request: (method, params) =>
      new Promise((resolve) => {
        const i = id++;
        pending.set(i, resolve);
        send({ id: i, method, params });
      }),
    notify: (method, params) => send({ method, params }),
  };
}

async function launchChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lspp-chrome-'));
  const proc = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ]);
  const wsUrl = await new Promise((resolve, reject) => {
    let err = '';
    proc.stderr.on('data', (d) => {
      err += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) resolve(m[1]);
    });
    proc.on('exit', () => reject(new Error('chrome exited: ' + err)));
  });
  const httpBase = wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/.*$/, '');
  const targets = await (await fetch(httpBase + '/json/list')).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 1;
  const pending = new Map();
  const events = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) events.push(msg);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = id++;
      pending.set(i, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + expression);
    return r.result.value;
  };
  return {
    send,
    evaluate,
    events,
    close() {
      ws.close();
      proc.kill();
      setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500);
    },
  };
}

async function waitFor(fn, what, timeout = 4000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (_) {
      /* page may be reloading */
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}; last=${JSON.stringify(last)}`);
}

test('browser client applies updates', { skip: !CHROME && 'Chrome not found' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lspp-'));
  const page = (body, head = '') =>
    `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>T</title>\n` +
    `<link rel="stylesheet" href="style.css">\n${head}</head>\n<body>\n${body}\n</body>\n</html>\n`;
  const indexPath = path.join(root, 'index.html');
  const cssPath = path.join(root, 'style.css');
  const initialBody =
    '<h1 id="title">Hello</h1>\n<ul><li id="a">A</li><li id="b">B</li><li id="c">C</li></ul>\n' +
    '<p class="x">para <b>bold</b></p>\n<input id="name" type="text">\n<script>window.scriptRuns=(window.scriptRuns||0)+1</script>';
  fs.writeFileSync(indexPath, page(initialBody));
  fs.writeFileSync(cssPath, 'h1 { color: rgb(255, 0, 0); }');

  const server = lsp(root);
  const chrome = await launchChrome();
  t.after(() => {
    chrome.close();
    server.proc.kill();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await server.request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(root).href,
    capabilities: {},
    initializationOptions: { port: 0, timeout: 30, autoStart: true },
  });
  server.notify('initialized', {});
  const live = await waitFor(() => server.notifications.find((n) => /is live at/.test(n.params?.message)), 'server');
  const port = Number(/:(\d+)\//.exec(live.params.message)[1]);

  const uri = pathToFileURL(indexPath).href;
  const cssUri = pathToFileURL(cssPath).href;
  let version = 1;
  server.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'html', version, text: page(initialBody) },
  });
  server.notify('textDocument/didOpen', {
    textDocument: { uri: cssUri, languageId: 'css', version, text: 'h1 { color: rgb(255, 0, 0); }' },
  });
  const edit = (docUri, text) =>
    server.notify('textDocument/didChange', { textDocument: { uri: docUri, version: ++version }, contentChanges: [{ text }] });

  await chrome.send('Page.enable');
  await chrome.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await waitFor(() => chrome.evaluate('window.__liveServerPlusPlus__ && window.__liveServerPlusPlus__.connectedOnce'), 'ws connect');
  await sleep(200); // let the baseline fetch finish

  // Marker that disappears on a full reload.
  await chrome.evaluate('window.marker = 42; document.getElementById("name").value = "typed"; true');
  const keepB = await chrome.evaluate('window.bNode = document.getElementById("b"); true');
  assert.ok(keepB);

  // 1. Hot update: text change, inserted/removed/reordered keyed nodes, attribute change.
  const body2 =
    '<h1 id="title" class="big">Hello, world</h1>\n<ul><li id="c">C</li><li id="new">N</li><li id="b">B!</li></ul>\n' +
    '<p class="y">changed <i>italic</i></p>\n<input id="name" type="text">\n<script>window.scriptRuns=(window.scriptRuns||0)+1</script>';
  edit(uri, page(body2));
  await waitFor(() => chrome.evaluate('document.getElementById("title").textContent === "Hello, world"'), 'hot update');
  assert.strictEqual(await chrome.evaluate('window.marker'), 42, 'no full reload for HTML changes');
  assert.strictEqual(await chrome.evaluate('window.scriptRuns'), 1);
  assert.strictEqual(await chrome.evaluate('document.getElementById("title").className'), 'big');
  assert.strictEqual(
    await chrome.evaluate('[...document.querySelectorAll("li")].map(l => l.id + ":" + l.textContent).join(",")'),
    'c:C,new:N,b:B!',
  );
  assert.strictEqual(await chrome.evaluate('document.getElementById("b") === window.bNode'), true, 'keyed nodes are moved, not recreated');
  assert.strictEqual(await chrome.evaluate('document.querySelector("p").outerHTML'), '<p class="y">changed <i>italic</i></p>');
  assert.strictEqual(await chrome.evaluate('document.getElementById("name").value'), 'typed', 'input state is kept');
  assert.strictEqual(
    await chrome.evaluate('!!document.querySelector("script[data-live-server-ignore]")'),
    true,
    'the injected client survives the head morph',
  );

  // The resulting body must match what the browser would have parsed from scratch.
  const expectedBody = await chrome.evaluate(
    `new DOMParser().parseFromString(${JSON.stringify(page(body2))}, "text/html").body.innerHTML`,
  );
  assert.strictEqual(await chrome.evaluate('document.body.innerHTML'), expectedBody);

  // 2. Inline <style> in head and title update live.
  const body3 = body2.replace('Hello, world', 'Styled');
  edit(uri, page(body3, '<style>p { margin-left: 7px; }</style>\n').replace('<title>T</title>', '<title>T2</title>'));
  await waitFor(() => chrome.evaluate('document.getElementById("title").textContent === "Styled"'), 'style update');
  assert.strictEqual(await chrome.evaluate('getComputedStyle(document.querySelector("p")).marginLeft'), '7px');
  assert.strictEqual(await chrome.evaluate('document.title'), 'T2');
  assert.strictEqual(await chrome.evaluate('window.marker'), 42);

  // 3. Unsaved CSS change swaps the stylesheet without a reload.
  assert.strictEqual(await chrome.evaluate('getComputedStyle(document.querySelector("h1")).color'), 'rgb(255, 0, 0)');
  edit(cssUri, 'h1 { color: rgb(0, 0, 255); }');
  await waitFor(
    () => chrome.evaluate('getComputedStyle(document.querySelector("h1")).color === "rgb(0, 0, 255)"'),
    'css refresh',
  );
  assert.strictEqual(await chrome.evaluate('window.marker'), 42, 'no full reload for CSS changes');
  assert.strictEqual(await chrome.evaluate('document.querySelectorAll("link[rel=stylesheet]").length'), 1);

  // 4. Changing a <script> falls back to a full reload.
  edit(uri, page(body3.replace('scriptRuns||0)+1', 'scriptRuns||0)+100'), '<style>p { margin-left: 7px; }</style>\n'));
  await waitFor(() => chrome.evaluate('window.marker === undefined && window.scriptRuns === 100'), 'reload on script change');
  await waitFor(() => chrome.evaluate('window.__liveServerPlusPlus__.connectedOnce'), 'reconnect');
  await sleep(200);

  // 5. After the reload, hot updates keep working (baseline is primed from the server).
  await chrome.evaluate('window.marker = 7; true');
  edit(uri, page(body3.replace('Styled', 'Again').replace('scriptRuns||0)+1', 'scriptRuns||0)+100'), '<style>p { margin-left: 7px; }</style>\n'));
  await waitFor(() => chrome.evaluate('document.getElementById("title").textContent === "Again"'), 'hot after reload');
  assert.strictEqual(await chrome.evaluate('window.marker'), 7);

  // 6. Randomised edits: the morphed DOM must always equal a fresh parse.
  let seed = 12345;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const tags = ['div', 'p', 'span', 'section', 'em', 'ul', 'li'];
  const randomTree = (depth) => {
    let out = '';
    const count = rand(5);
    for (let i = 0; i < count; i++) {
      const kind = rand(10);
      if (kind < 3 || depth > 3) out += ['foo', 'bar ', ' baz', 'qux'][rand(4)];
      else if (kind === 3) out += `<!-- c${rand(3)} -->`;
      else {
        const tag = tags[rand(tags.length)];
        const id = rand(4) === 0 ? ` id="k${rand(6)}"` : '';
        const cls = rand(3) === 0 ? ` class="c${rand(3)}"` : '';
        out += `<${tag}${id}${cls}>${randomTree(depth + 1)}</${tag}>`;
      }
    }
    return out;
  };
  const script = '<script>window.scriptRuns=(window.scriptRuns||0)+100</script>';
  for (let round = 0; round < 25; round++) {
    const html = page(`<main>${randomTree(0)}</main>${randomTree(1)}\n${script}`, '<style>p { margin-left: 7px; }</style>\n');
    const expected = await chrome.evaluate(
      `new DOMParser().parseFromString(${JSON.stringify(html)}, "text/html").body.innerHTML`,
    );
    edit(uri, html);
    await waitFor(
      () => chrome.evaluate(`document.body.innerHTML === ${JSON.stringify(expected)}`),
      `random round ${round}`,
    );
  }
  assert.strictEqual(await chrome.evaluate('window.marker'), 7, 'random edits never needed a full reload');
});
