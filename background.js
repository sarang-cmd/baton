/**
 * Baton background worker.
 *
 * Loaded by manifest.json. The event side lives in notifications/worker.js,
 * which this file pulls in below; the message relays stay here.
 *
 * Two jobs:
 *   - the toolbar button opens the full settings page in a tab, since the
 *     settings now live in the on-page panel rather than a popup
 *   - the settings UI runs in a shadow root inside the page, so its messages
 *     have to be relayed to the arena.ai tab
 */
const ARENA = /^https:\/\/([a-z0-9-]+\.)?arena\.ai\//i;

// The toolbar button is registered before anything else, and the notification
// stack is loaded afterwards inside a guard. Those two must not be able to take
// each other down: a module that throws while loading used to kill the whole
// worker, and the button then did nothing at all when clicked.
let bootError = null;

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
});

try {
  // pure event layer, dedupe, wording, and the worker
  importScripts(
    'notifications/events.js',
    'notifications/dedupe.js',
    'notifications/notifier.js',
    'notifications/worker.js'
  );
} catch (err) {
  // notifications are optional; auto-continue and the settings page are not
  bootError = String((err && err.message) || err);
  console.error('Baton: notifications did not load:', bootError);
}

function activeArenaTab(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    cb(tab && ARENA.test(tab.url || '') ? tab : null);
  });
}

/**
 * A reply that always happens.
 *
 * Returning true from an onMessage listener tells Chrome "an answer is coming".
 * If the answer never arrives, Chrome logs "the message channel closed before a
 * response was received" and the caller's callback never runs, which looks
 * exactly like a notification that was silently dropped. So every asynchronous
 * branch answers exactly once, and a watchdog answers for it if the work stalls.
 */
// overridable so a test can prove the watchdog fires without waiting six seconds
const REPLY_TIMEOUT_MS = (typeof globalThis !== 'undefined' && globalThis.__batonReplyTimeout) || 6000;

function once(reply, timeoutMs = REPLY_TIMEOUT_MS) {
  let answered = false;
  const timer = setTimeout(() => {
    answer({ ok: false, reason: 'timeout' });
  }, timeoutMs);
  function answer(payload) {
    if (answered) return;
    answered = true;
    clearTimeout(timer);
    try {
      reply(payload);
    } catch (_) {
      /* the caller went away first, which is not an error */
    }
  }
  return answer;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  // handlers below call this, never reply directly, so that no branch can hang
  const done = once(reply);
  if (!msg || !msg.type) return;

  if (msg.type === 'baton-notify') {
    // the content script cannot raise notifications itself, and should not be
    // allowed to raise them without the user having switched this on
    chrome.storage.local.get(['settings'], (res) => {
      void (chrome.runtime && chrome.runtime.lastError);
      const on = !res || !res.settings || res.settings.notifyOnPause !== false;
      if (on) {
        chrome.notifications.create('', {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: String(msg.title || 'Baton'),
          message: String(msg.message || ''),
          priority: 1
        }, () => void chrome.runtime.lastError);
      }
      done({ ok: on });
    });
    return true;
  }

  if (msg.type === 'baton-test-notification') {
    try {
      chrome.notifications.create('baton:test', {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'Arena: this is a test',
        message: 'Notifications are working. Real ones name the event, not the answer.',
        priority: 1
      }, () => {
        done({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError && chrome.runtime.lastError.message });
      });
    } catch (e) {
      done({ ok: false, error: String(e && e.message) });
    }
    return true;
  }

  if (msg.type === 'baton-limit-outcome') {
    const worker = self.BatonWorker;
    if (worker && msg.turnId) worker.noteLimitOutcome(msg.threadId, msg.turnId, msg.continued);
    done({ ok: !!worker });
    return true;
  }

  if (msg.type === 'baton-boot') {
    // lets the options page say plainly when the notification stack failed
    done({ ok: true, version: chrome.runtime.getManifest().version, error: bootError });
    return true;
  }

  if (msg.type === 'baton-evaluation') {
    const worker = self.BatonWorker;
    if (worker && worker.noteEvaluation) worker.noteEvaluation(msg.update);
    done({ ok: !!worker });
    return true;
  }

  if (msg.type === 'baton-diag') {
    const worker = self.BatonWorker;
    if (worker && worker.noteDiag) worker.noteDiag(msg.diag);
    done({ ok: !!worker });
    return true;
  }

  if (msg.type === 'baton-test-event') {
    const worker = self.BatonWorker;
    if (!worker) { done({ ok: false, reason: 'no-worker', error: bootError }); return; }
    worker.testEvent((ok) => done({ ok }));
    return true;
  }

  if (msg.type === 'baton-event') {
    const events = Array.isArray(msg.events) ? msg.events : [];
    const worker = self.BatonWorker;
    if (!worker) { done({ ok: false, reason: 'no-worker', error: bootError }); return true; }
    let notified = 0;
    let pending = events.length;
    if (!pending) { done({ ok: true, notified: 0 }); return true; }
    for (const event of events) {
      try {
        worker.intake(event, msg.context || {}, (yes) => {
          if (yes) notified += 1;
          pending -= 1;
          if (pending === 0) done({ ok: true, notified });
        });
      } catch (err) {
        // one bad event must not swallow the reply for the others
        pending -= 1;
        console.error('Baton: intake threw', String(err && err.message));
        if (pending === 0) done({ ok: true, notified, error: 'intake-threw' });
      }
    }
    return true;
  }

  if (msg.type === 'baton-open-settings') {
    chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
    done({ ok: true });
    return true;
  }

  if (msg.type === 'baton-pick') {
    activeArenaTab((tab) => {
      if (!tab) { done({ ok: false, reason: 'no-arena-tab' }); return; }
      chrome.tabs.sendMessage(tab.id, { type: 'baton-pick' }, (res) => {
        done(res && res.ok ? { ok: true } : { ok: false, reason: 'no-content-script' });
      });
    });
    return true; // async reply
  }

  if (msg.type === 'baton-reset') {
    activeArenaTab((tab) => {
      if (!tab) { done({ ok: false }); return; }
      chrome.tabs.sendMessage(tab.id, { type: 'baton-reset' }, () => done({ ok: true }));
    });
    return true;
  }
});
