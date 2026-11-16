/**
 * Page observer
 * ------------------------------------------------------------------
 * Reads what the page already receives, and nothing else. It issues no requests
 * of its own: notifications/tap.js, running in the page's own context, hands it
 * a structural summary of every /api/chat and /api/evaluation response the page
 * fetches for its own reasons. Summaries carry roles, part types, part states,
 * flags and text lengths, never text.
 *
 * Polling was removed in 1.5.0. Fetching /api/chat every second from every open
 * tab is what got accounts rate limited for hours.
 *
 * Runs in the content script. Everything it learns goes to the background worker
 * as one message, which is where dedupe and notifications live.
 *
 * It also reports a structural summary of what it saw, and what it decided, to
 * the worker, which the settings page shows. That report carries key names, part
 * types and states, and lengths. Never text, never a title, never an id beyond a
 * short prefix, so a wrong assumption can be found without reading anyone's
 * conversation.
 */
(() => {
  const root = typeof self !== 'undefined' ? self : globalThis;
  const Events = root.BatonEvents;
  // an unmarked shape has to look the same for this long before it counts as
  // finished, so a slow token does not notify mid-answer
  const SETTLE_MS = 6000;
  // the DOM is checked on a timer, which costs nothing: it reads the page, and
  // an observer callback only runs when the page actually changes
  const DOM_TICK_MS = 1500;
  const DIAG_MIN_MS = 2000;

  let timer = null;
  let previous = null;
  let chatId = null;
  let mode = null;
  let inFlight = false;
  let stoppedIds = new Set();
  let lastEventDebug = [];

  // settling: same fingerprint for SETTLE_MS means nothing is happening
  let fingerprint = null;
  let unchangedSince = 0;

  // diagnostics
  let diag = null;
  let lastDiagSent = 0;
  const HISTORY = 12;
  let history = [];

  const MODE_BY_SEGMENT = { agent: 'agent', code: 'coding', c: 'agent', chat: 'agent' };
  const UUID = /^[0-9a-f]{8,}(-[0-9a-f]{4,})*$/i;

  /**
   * The chat id for the current page.
   *
   * The route is tried first, because it is instant and needs no traffic. Arena
   * has used several shapes over time, so any single path segment that looks
   * like an id is accepted, and the segment before it names the mode when it is
   * one we know. When the path carries nothing, the id is read back out of the
   * requests the page itself has already made, which covers routes that do not
   * put the id in the address bar.
   */
  function readRoute() {
    const segments = location.pathname.split('/').filter(Boolean);
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.length >= 8 && UUID.test(seg)) {
        const before = i > 0 ? segments[i - 1].toLowerCase() : '';
        return { chatId: seg, mode: MODE_BY_SEGMENT[before] || 'agent', from: 'path' };
      }
    }
    const id = idFromTraffic();
    if (id) return { chatId: id, mode: 'agent', from: 'traffic' };
    return { chatId: null, mode: null, from: null };
  }

  /** The most recent chat id the page asked Arena about. */
  function idFromTraffic() {
    try {
      const entries = typeof performance !== 'undefined' && performance.getEntriesByType
        ? performance.getEntriesByType('resource')
        : [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const m = /\/api\/chat\/([0-9a-f-]{8,})(?:[/?]|$)/i.exec(entries[i].name || '');
        if (m) return m[1];
      }
    } catch (_) {}
    return null;
  }

  /**
   * Is the page visibly busy? Two structural checks, no prose: a control whose
   * accessible name is Stop, and any element marked as streaming. Reported in
   * the diagnostics only, never used to decide an event, so a wrong guess here
   * cannot raise a notification.
   */
  function domActivity() {
    try {
      const controls = Array.from(document.querySelectorAll('button, [role="button"]'));
      const stop = controls.filter((el) => {
        const name = (el.getAttribute('aria-label') || el.title || el.textContent || '').trim();
        return name.length <= 24 && /^stop\b/i.test(name);
      }).length;
      const streaming = document.querySelectorAll(
        '[data-streaming="true"], [aria-busy="true"], [data-state="streaming"]').length;
      return { stopControls: stop, streamingMarks: streaming };
    } catch (_) {
      return { stopControls: 0, streamingMarks: 0 };
    }
  }

  function debug(entry) {
    // event types and decisions only: no text, no ids beyond a short prefix
    lastEventDebug.push(entry);
    if (lastEventDebug.length > 20) lastEventDebug.shift();
  }

  function emit(events) {
    const kept = (events || []).filter((e) => e && e.type && e.type !== 'suppressed');
    if (!kept.length) return;
    for (const event of kept) {
      debug({ at: Date.now(), type: event.type, mode: event.mode, turn: String(event.turnId).slice(0, 8) });
    }
    try {
      chrome.runtime.sendMessage({ type: 'baton-event', events: kept, context: { threadTitle: threadTitle() } },
        () => void (chrome.runtime && chrome.runtime.lastError));
    } catch (_) {}
    if (diag) diag.events = kept.map((e) => ({ type: e.type, at: Date.now(), signal: e.signal || null }));
    reportDiag(true);
  }

  /** The tab title without the Arena suffix, used as a thread name. */
  function threadTitle() {
    const t = (document.title || '').replace(/\s*[|\u2013\u2014-]\s*(Arena|arena\.ai).*$/i, '').trim();
    return t ? t.slice(0, 120) : null;
  }

  /** A structural fingerprint: ids, roles, part types and states, text lengths. */
  function fingerprintOf(state) {
    const messages = (state && state.messages) || [];
    return messages.map((m) => {
      const meta = m && m.metadata ? m.metadata : {};
      const parts = (m && m.parts) || [];
      return [
        m && m.id ? m.id : '',
        m && m.role ? m.role : '',
        meta.pending === true ? 1 : 0,
        parts.map((p) => [p.type || '', p.state || '',
          typeof p.text === 'string' ? p.text.length : 0].join(':')).join(',')
      ].join('|');
    }).join(';');
  }

  /**
   * One summary in from the tap. This replaces the whole polling loop: the page
   * already asked Arena for this, so the answer is already on its way.
   */
  function noteSummary(summary, kind) {
    if (!summary) return;
    const route = readRoute();
    if (kind === 'evaluation') {
      noteEvaluation(summary);
      return;
    }
    if (route.chatId && summary.id && String(summary.id).indexOf(String(route.chatId).slice(0, 8)) === -1 &&
        summary.id !== route.chatId) {
      // a summary for a different thread, for example one the page prefetched
      return;
    }
    if (!route.chatId) return;

    if (route.chatId !== chatId) {
      chatId = route.chatId;
      mode = route.mode;
      previous = null;
      history = [];
      fingerprint = null;
      unchangedSince = 0;
      diag = null;
    }

    receive(summary, route.from);
  }

  /** Feed one structural summary through the event layer. */
  function receive(summary, from) {
    if (!Events) return;
    const now = Date.now();
    diag = diag || { at: now, events: [] };
    diag.at = now;
    diag.page = location.pathname.slice(0, 80);
    diag.route = { chatId: chatId ? chatId.slice(0, 8) : null, mode, from, passive: true };

    const fp = fingerprintOf(summary);
    if (fp !== fingerprint) {
      fingerprint = fp;
      unchangedSince = now;
    }
    const settled = unchangedSince > 0 && now - unchangedSince >= SETTLE_MS;

    const events = Events.fromChatState(previous, summary, { mode, stoppedIds, settled });
    const doneEvent = events.find((e) => e.type === 'response_done');

    diag.messages = (summary.messages || []).length;
    diag.shape = Events.shapeOf(summary);
    diag.dom = domActivity();
    diag.decision = {
      settled,
      unchangedMs: unchangedSince ? now - unchangedSince : 0,
      baseline: previous === null,
      finished: !!doneEvent,
      signal: doneEvent ? doneEvent.signal : null,
      passive: 'no request was made by Baton'
    };

    const last = (summary.messages || [])[(summary.messages || []).length - 1] || null;
    const assistants = (summary.messages || []).filter((m) => m && m.role === 'assistant');
    const tail = assistants.length ? assistants[assistants.length - 1] : null;
    const tailMeta = (tail && tail.metadata) || {};
    history.push({
      t: new Date(now).toLocaleTimeString(),
      n: (summary.messages || []).length,
      lastRole: last ? last.role : null,
      assistant: tail ? 1 : 0,
      pending: tail ? (tailMeta.pending === undefined ? 'absent' : !!tailMeta.pending) : null,
      parts: tail ? (tail.parts || []).length : 0,
      settled,
      out: events.map((e) => e.type)
    });
    if (history.length > HISTORY) history.shift();
    diag.history = history.slice();

    previous = summary;
    emit(events);
    reportDiag(false);
  }

  /** An evaluation status the page fetched for itself. */
  function noteEvaluation(update) {
    try {
      chrome.runtime.sendMessage({ type: 'baton-evaluation', update },
        () => void (chrome.runtime && chrome.runtime.lastError));
    } catch (_) {}
  }

  /** Send the report at most every DIAG_MIN_MS, or immediately when it matters. */
  function reportDiag(force) {
    if (!diag) return;
    const now = Date.now();
    if (!force && now - lastDiagSent < DIAG_MIN_MS) return;
    lastDiagSent = now;
    try {
      chrome.runtime.sendMessage({ type: 'baton-diag', diag }, () => void (chrome.runtime && chrome.runtime.lastError));
    } catch (_) {}
  }

  /**
   * The last structural summary, for the content script to turn into a limit
   * event. The banner detector and the event layer read the same snapshot.
   */
  function snapshot() {
    return { state: previous, mode };
  }

  /** The background worker tells us which message ids the user stopped. */
  function noteStopped(ids) {
    for (const id of ids || []) stoppedIds.add(id);
    if (stoppedIds.size > 50) stoppedIds = new Set([...stoppedIds].slice(-50));
  }

  /** Messages from the tap. Same window, so check the source as well. */
  function onTapMessage(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__batonTap !== 1) return;
    try {
      if (data.kind === 'chat') noteSummary(data.payload, 'chat');
      else if (data.kind === 'evaluation') noteSummary(data.payload, 'evaluation');
    } catch (_) {
      /* a malformed summary must never break the page */
    }
  }

  /**
   * Start observing. This installs a message listener and a DOM timer, and
   * makes no network request of any kind.
   */
  function start() {
    if (timer) return;
    window.addEventListener('message', onTapMessage);
    const tick = () => {
      // the DOM half: a Stop control on the page means a run is live, which is
      // the only thing that can tell an unmarked summary that it is not settled
      const activity = domActivity();
      const active = activity.stopControls > 0 || activity.streamingMarks > 0;
      if (active) unchangedSince = Date.now();
      if (diag) diag.dom = activity;
      timer = setTimeout(tick, DOM_TICK_MS);
    };
    tick();
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
    window.removeEventListener('message', onTapMessage);
    previous = null;
  }

  /**
   * Kept so callers and tests do not break. It performs no request: polling was
   * removed in 1.5.0 because it rate limited accounts.
   */
  function pollOnce() {
    return { skipped: 'passive', reason: 'Baton reads the page traffic, it does not poll' };
  }

  /** The turn the limit banner belongs to, as far as the last summary knows. */
  function currentTurn() {
    if (!Events || !previous) return null;
    const events = Events.fromLimit(previous, { mode });
    return events.length ? events[0].turnId : null;
  }

  root.BatonObserve = {
    start, stop, snapshot, noteStopped, pollOnce, currentTurn, readRoute,
    // exposed for the tests, and for a page that hands over a summary directly
    noteSummary, receive,
    debug: () => lastEventDebug.slice(),
    diag: () => diag
  };
})();
