/*
 * Live Server++ for Zed – browser client.
 *
 * Injected into every served HTML page. Connects to the server over WebSocket
 * and applies updates:
 *   - "hot"            : morphs the current DOM into the new document in place
 *   - "partial-reload" : replaces <body> (and <title>) without a page refresh
 *   - "refreshcss"     : swaps local stylesheets without flashing
 *   - "reload"         : full page reload
 */
(function () {
  'use strict';
  if (window.__liveServerPlusPlus__) return;

  var WS_PATH = '/__live_server_pp__/ws';
  var IGNORE_ATTR = 'data-live-server-ignore';
  var state = (window.__liveServerPlusPlus__ = { log: [], socket: null, connectedOnce: false });

  function log() {
    state.log.push(Array.prototype.slice.call(arguments));
    if (state.log.length > 200) state.log.shift();
  }

  // ------------------------------------------------------------------------
  // Connection
  // ------------------------------------------------------------------------

  var retryDelay = 500;

  function connect() {
    if (!('WebSocket' in window)) {
      console.error('Live Server++: this browser does not support WebSocket.');
      return;
    }
    var protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var socket = new WebSocket(protocol + location.host + WS_PATH);
    state.socket = socket;

    socket.onopen = function () {
      retryDelay = 500;
      socket.send(JSON.stringify({ watchList: [location.pathname] }));
      if (state.connectedOnce) {
        // The server was restarted: the page may be stale.
        return location.reload();
      }
      state.connectedOnce = true;
      primeBaseline();
      if (!sessionStorage.getItem('LiveServerPlusPlus.connected')) {
        console.log('Live Server++: connected!');
        sessionStorage.setItem('LiveServerPlusPlus.connected', '1');
      }
    };

    socket.onmessage = function (event) {
      var message;
      try {
        message = JSON.parse(event.data);
      } catch (err) {
        return log('bad message', event.data);
      }
      handle(message.action, message.data || {});
    };

    socket.onclose = function () {
      // Keep trying so the page reconnects (and refreshes) when the server comes back.
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 5000);
    };

    socket.onerror = function (event) {
      log('socket error', event);
    };
  }

  function handle(action, data) {
    switch (action) {
      case 'connected':
        return;
      case 'refreshcss':
        return refreshCSS();
      case 'hot':
        return attempt([hotUpdate, partialReload, fullReload], data.dom);
      case 'partial-reload':
        return attempt([partialReload, fullReload], data.dom);
      case 'reload':
      default:
        return fullReload();
    }
  }

  function attempt(strategies, html) {
    for (var i = 0; i < strategies.length; i++) {
      try {
        strategies[i](html);
        return;
      } catch (err) {
        log('update strategy failed', strategies[i].name, err);
      }
    }
  }

  function fullReload() {
    location.reload();
  }

  // ------------------------------------------------------------------------
  // HTML updates
  // ------------------------------------------------------------------------

  // Signature of the <script> elements of the last known *source* document. Computed from
  // the server's HTML rather than the live DOM, which page scripts may have modified.
  var baselineScripts = null;

  function primeBaseline() {
    if (!window.fetch) return;
    fetch(location.href, { cache: 'no-store' })
      .then(function (res) {
        var type = res.headers.get('content-type') || '';
        return res.ok && type.indexOf('html') !== -1 ? res.text() : null;
      })
      .then(function (text) {
        if (text !== null && baselineScripts === null) baselineScripts = scriptSignature(parse(text));
      })
      .catch(function (err) {
        log('could not prime baseline', err);
      });
  }

  function parse(html) {
    if (typeof html !== 'string') throw new Error('No document received');
    return new DOMParser().parseFromString(html, 'text/html');
  }

  function scriptSignature(doc) {
    var scripts = doc.querySelectorAll('script:not([' + IGNORE_ATTR + '])');
    var parts = [];
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i];
      parts.push((s.getAttribute('src') || '') + '|' + (s.getAttribute('type') || '') + '|' + s.textContent);
    }
    return parts.join('\u0000');
  }

  /** Scripts can't be re-executed by patching the DOM: a change to them needs a reload. */
  function scriptsChanged(newDoc) {
    var next = scriptSignature(newDoc);
    var previous = baselineScripts !== null ? baselineScripts : scriptSignature(document);
    baselineScripts = next;
    return next !== previous;
  }

  function hotUpdate(html) {
    var doc = parse(html);
    if (!doc.body) throw new Error('Document has no body');
    // Detect script changes *before* touching the DOM.
    if (scriptsChanged(doc)) return fullReload();
    var scrollX = window.scrollX;
    var scrollY = window.scrollY;
    if (doc.title !== document.title) document.title = doc.title;
    syncAttributes(document.documentElement, doc.documentElement);
    morphChildren(document.head, doc.head);
    morphElement(document.body, doc.body);
    window.scrollTo(scrollX, scrollY);
  }

  function partialReload(html) {
    var doc = parse(html);
    if (!doc.body) throw new Error('Document has no body');
    if (scriptsChanged(doc)) return fullReload();
    var scrollX = window.scrollX;
    var scrollY = window.scrollY;
    if (doc.title !== document.title) document.title = doc.title;
    morphChildren(document.head, doc.head);
    var body = document.importNode(doc.body, true);
    document.body.replaceWith(body);
    window.scrollTo(scrollX, scrollY);
  }

  // ------------------------------------------------------------------------
  // A small DOM morphing algorithm (in the spirit of morphdom / diffDOM)
  // ------------------------------------------------------------------------

  function isIgnored(node) {
    return node.nodeType === 1 && node.hasAttribute(IGNORE_ATTR);
  }

  function nodeKey(node) {
    return node.nodeType === 1 ? node.getAttribute('id') || null : null;
  }

  function isSameKind(a, b) {
    if (a.nodeType !== b.nodeType) return false;
    if (a.nodeType !== 1) return true;
    if (a.nodeName !== b.nodeName) return false;
    var ka = nodeKey(a);
    var kb = nodeKey(b);
    return ka === kb || (!ka && !kb);
  }

  function syncAttributes(from, to) {
    var i;
    var attr;
    for (i = from.attributes.length - 1; i >= 0; i--) {
      attr = from.attributes[i];
      if (!to.hasAttribute(attr.name)) from.removeAttribute(attr.name);
    }
    for (i = 0; i < to.attributes.length; i++) {
      attr = to.attributes[i];
      if (from.getAttribute(attr.name) !== attr.value) from.setAttribute(attr.name, attr.value);
    }
    // Keep form state in sync with the "value"/"checked" attributes.
    var tag = from.nodeName;
    if (tag === 'INPUT') {
      if (from.type === 'checkbox' || from.type === 'radio') {
        from.checked = to.hasAttribute('checked');
      } else if (from.value !== (to.getAttribute('value') || '') && to.hasAttribute('value')) {
        from.value = to.getAttribute('value');
      }
    } else if (tag === 'TEXTAREA') {
      if (from.value !== to.textContent) from.value = to.textContent;
    } else if (tag === 'OPTION') {
      from.selected = to.hasAttribute('selected');
    }
  }

  function morphElement(from, to) {
    syncAttributes(from, to);
    // <template> keeps its children in a separate fragment.
    if (from.nodeName === 'TEMPLATE') {
      if (from.innerHTML !== to.innerHTML) from.innerHTML = to.innerHTML;
      return;
    }
    // Leave <script> elements alone: their content changes are handled by a reload.
    if (from.nodeName === 'SCRIPT') return;
    morphChildren(from, to);
  }

  function morphNode(from, to) {
    if (from.nodeType === 1) return morphElement(from, to);
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
  }

  function createNode(to) {
    // Imported scripts don't execute; that's fine because script changes trigger a reload.
    return document.importNode(to, true);
  }

  function morphChildren(fromParent, toParent) {
    var toChildren = Array.prototype.slice.call(toParent.childNodes);
    var current = fromParent.firstChild;

    // Index keyed (id) elements of the old tree for moves.
    var keyed = {};
    for (var n = fromParent.firstChild; n; n = n.nextSibling) {
      var k = nodeKey(n);
      if (k) keyed[k] = n;
    }

    for (var i = 0; i < toChildren.length; i++) {
      var to = toChildren[i];
      while (current && isIgnored(current)) current = current.nextSibling;

      var key = nodeKey(to);
      if (key && keyed[key] && keyed[key] !== current && keyed[key].parentNode === fromParent && isSameKind(keyed[key], to)) {
        // Move the keyed element into place.
        var moved = keyed[key];
        fromParent.insertBefore(moved, current);
        morphNode(moved, to);
        continue;
      }

      if (current && isSameKind(current, to)) {
        var next = current.nextSibling;
        morphNode(current, to);
        current = next;
        continue;
      }

      // Look ahead a few siblings for a match (handles insertions and deletions).
      var match = null;
      var probe = current;
      for (var steps = 0; probe && steps < 8; steps++, probe = probe.nextSibling) {
        if (!isIgnored(probe) && !nodeKey(probe) && isSameKind(probe, to) && sameTextIfLeaf(probe, to)) {
          match = probe;
          break;
        }
      }
      var nextToMatch = toChildren[i + 1];
      if (match && !(nextToMatch && current && isSameKind(current, nextToMatch) && !isSameKind(current, to))) {
        // Remove the nodes between `current` and the match – they were deleted.
        while (current !== match) {
          var dead = current;
          current = current.nextSibling;
          if (!isIgnored(dead)) fromParent.removeChild(dead);
        }
        var after = match.nextSibling;
        morphNode(match, to);
        current = after;
        continue;
      }

      // New node.
      fromParent.insertBefore(createNode(to), current);
    }

    // Remove leftovers.
    while (current) {
      var nextNode = current.nextSibling;
      if (!isIgnored(current)) fromParent.removeChild(current);
      current = nextNode;
    }
  }

  function sameTextIfLeaf(a, b) {
    if (a.nodeType === 3 || a.nodeType === 8) return a.nodeValue === b.nodeValue;
    return true;
  }

  // ------------------------------------------------------------------------
  // CSS updates
  // ------------------------------------------------------------------------

  function refreshCSS() {
    var links = Array.prototype.slice.call(document.querySelectorAll('link[rel~="stylesheet"][href]'));
    links.forEach(function (link) {
      if (link.hasAttribute(IGNORE_ATTR)) return;
      var href = link.getAttribute('href');
      if (!href) return;
      var resolved;
      try {
        resolved = new URL(href, location.href);
      } catch (err) {
        return;
      }
      if (resolved.origin !== location.origin) return;
      resolved.searchParams.set('_lspp', String(Date.now()));

      // Load the new sheet next to the old one and swap when ready: no flash of unstyled content.
      var clone = link.cloneNode(false);
      clone.setAttribute('href', resolved.pathname + resolved.search + resolved.hash);
      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
        if (link.parentNode) link.parentNode.removeChild(link);
      };
      clone.onload = finish;
      clone.onerror = finish;
      setTimeout(finish, 3000);
      link.parentNode.insertBefore(clone, link.nextSibling);
    });

    // Also refresh @import-ed sheets inside <style> tags by reapplying their text.
    Array.prototype.slice.call(document.querySelectorAll('style')).forEach(function (style) {
      if (/@import/i.test(style.textContent)) {
        style.textContent = style.textContent.replace(
          /(@import\s+(?:url\()?\s*['"]?)([^'")\s]+)/gi,
          function (_m, prefix, u) {
            var clean = u.replace(/([?&])_lspp=\d+&?/, '$1').replace(/[?&]$/, '');
            return prefix + clean + (clean.indexOf('?') >= 0 ? '&' : '?') + '_lspp=' + Date.now();
          }
        );
      }
    });
  }

  // ------------------------------------------------------------------------

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', connect);
  } else {
    connect();
  }
})();
