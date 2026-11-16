/**
 * Read-only tap
 * ------------------------------------------------------------------
 * Runs in the page's own JavaScript context (manifest: "world": "MAIN",
 * document_start) and wraps fetch and XMLHttpRequest so that responses the page
 * ALREADY receives can be read a second time.
 *
 * It never issues a request of its own. That is the whole point: Baton used to
 * poll /api/chat every second or two per tab and /api/evaluation for up to ten
 * minutes per turn, which is enough traffic to look like a bot and get an
 * account rate limited for hours. This file adds exactly zero requests.
 *
 * What crosses into the extension is a structural summary: roles, part types,
 * part states, the pending and finishReason flags, and text lengths. The answer
 * text is measured and dropped here, so it never leaves this function.
 */
(() => {
  if (window.__batonTap) return;
  window.__batonTap = true;

  const CHAT = /\/api\/chat\/([0-9a-f-]{8,}[0-9a-f-]*)/i;
  const EVAL = /\/api\/evaluation\/[^/]+\/([0-9a-f-]{8,}[0-9a-f-]*)/i;
  const MAX_MESSAGES = 60;
  const MAX_PARTS = 24;

  const textLength = (part) => {
    if (typeof part.text === 'string') return part.text.length;
    if (typeof part.content === 'string') return part.content.length;
    return 0;
  };

  /** Keep shape, drop content. This is the only thing that leaves the page. */
  function summariseMessage(message) {
    if (!message || typeof message !== 'object') return null;
    const meta = message.metadata || {};
    const parts = Array.isArray(message.parts) ? message.parts : [];
    return {
      id: typeof message.id === 'string' ? message.id : null,
      role: typeof message.role === 'string' ? message.role : null,
      metadata: {
        pending: typeof meta.pending === 'boolean' ? meta.pending : undefined,
        finishReason: typeof meta.finishReason === 'string' ? meta.finishReason : undefined,
        status: typeof meta.status === 'string' ? meta.status : undefined,
        stopped: meta.stopped === true ? true : undefined
      },
      parts: parts.slice(-MAX_PARTS).map((part) => ({
        type: typeof part.type === 'string' ? part.type : null,
        state: typeof part.state === 'string' ? part.state : null,
        // ---- content stops here ----
        textLength: textLength(part)
      }))
    };
  }

  function summariseChat(body, chatId) {
    if (!body || typeof body !== 'object') return null;
    const messages = Array.isArray(body.messages) ? body.messages : null;
    if (!messages) return null;
    return {
      id: typeof body.id === 'string' ? body.id : chatId,
      messages: messages.slice(-MAX_MESSAGES).map(summariseMessage).filter(Boolean)
    };
  }

  function post(kind, payload) {
    try {
      window.postMessage({ __batonTap: 1, kind, payload, at: Date.now() }, location.origin);
    } catch (_) {
      /* the page sandbox refused; notifications stay off this turn */
    }
  }

  /** Decide whether a URL and body matter, and reduce it if so. */
  function offer(url, body) {
    if (!url || typeof url !== 'string') return;
    if (!body || typeof body !== 'object') return;

    const chat = CHAT.exec(url);
    if (chat && Array.isArray(body.messages)) {
      const summary = summariseChat(body, chat[1]);
      if (summary && summary.messages.length) post('chat', summary);
      return;
    }
    const evaluation = EVAL.exec(url);
    if (evaluation && typeof body.status === 'string') {
      post('evaluation', { messageId: evaluation[1], status: body.status });
    }
  }

  function parse(text) {
    if (typeof text !== 'string' || text.length < 2) return null;
    const head = text.charCodeAt(0);
    // only JSON objects, so a stream or HTML never reaches JSON.parse
    if (head !== 123) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  /* ---------------------------------------------------------------- fetch */

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function batonTapFetch(input, init) {
      const promise = originalFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        promise.then((response) => {
          try {
            if (!response || !response.ok) return;
            const type = response.headers && response.headers.get
              ? response.headers.get('content-type') || ''
              : '';
            if (type.indexOf('json') === -1) return;
            response.clone().text().then((text) => offer(url, parse(text))).catch(() => {});
          } catch (_) {}
        }).catch(() => {});
      } catch (_) {}
      return promise;
    };
  }

  /* ------------------------------------------------------------------ xhr */

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;

    XHR.prototype.open = function batonTapOpen(method, url) {
      try {
        this.__batonUrl = typeof url === 'string' ? url : '';
      } catch (_) {}
      return open.apply(this, arguments);
    };

    XHR.prototype.send = function batonTapSend() {
      try {
        const xhr = this;
        xhr.addEventListener('load', () => {
          try {
            if (xhr.status < 200 || xhr.status >= 300) return;
            const type = (xhr.getResponseHeader('content-type') || '').toLowerCase();
            if (type.indexOf('json') === -1) return;
            if (xhr.responseType && xhr.responseType !== 'text' && xhr.responseType !== 'json') return;
            const body = xhr.responseType === 'json' ? xhr.response : parse(xhr.responseText);
            offer(xhr.__batonUrl, body);
          } catch (_) {}
        });
      } catch (_) {}
      return send.apply(this, arguments);
    };
  }
})();
