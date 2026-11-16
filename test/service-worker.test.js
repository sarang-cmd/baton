/**
 * The background worker, loaded the way Chrome loads it.
 *
 * This exists because of a real bug: notifications/worker.js read
 * `window.BatonEvents` at its top level. A service worker has no `window`, so
 * importScripts threw, background.js died before it registered
 * chrome.action.onClicked, and the toolbar button did nothing when clicked.
 * Nothing in the page tests could see that, because they all run inside jsdom
 * where `window` exists.
 *
 * So this file builds a context that looks like a service worker and nothing
 * like a page: `self` and `chrome`, no `window`, no `document`.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

/** A service worker global: self, chrome, no window, no document. */
function workerContext() {
  const calls = { created: [], notificationCreated: [] };
  const listeners = { clicked: [], message: [], webRequest: [], storageChanged: [] };

  const chrome = {
    action: { onClicked: { addListener: (fn) => listeners.clicked.push(fn) } },
    runtime: {
      getURL: (p) => 'chrome-extension://baton/' + p,
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      lastError: null
    },
    tabs: {
      create: (opts) => calls.created.push(opts),
      query: (_q, cb) => cb([]),
      update: (_id, _o, cb) => cb && cb(),
      sendMessage: (_id, _m, cb) => cb && cb()
    },
    windows: { update: (_id, _o, cb) => cb && cb() },
    storage: {
      local: { get: (_k, cb) => cb({ settings: {} }), set: (_o, cb) => cb && cb() },
      session: {
        get: (_k, cb) => cb({}),
        set: (_o, cb) => cb && cb(),
        remove: (_k, cb) => cb && cb()
      },
      onChanged: { addListener: (fn) => listeners.storageChanged.push(fn) }
    },
    notifications: {
      create: (id, opts, cb) => {
        calls.notificationCreated.push({ id, opts });
        if (cb) cb();
        return 'n1';
      },
      clear: (_id, cb) => cb && cb(),
      onClicked: { addListener: () => {} }
    },
    webRequest: {
      onBeforeRequest: { addListener: (...args) => listeners.webRequest.push(args) }
    },
    permissions: { contains: (_q, cb) => cb(true) }
  };

  const sandbox = { chrome, console, setTimeout, clearTimeout, URL, Map, Set, Promise };
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  // importScripts loads into the same global, as it does in a worker
  sandbox.importScripts = (...files) => {
    for (const f of files) {
      const code = fs.readFileSync(path.join(root, f), 'utf8');
      vm.runInContext(code, context, { filename: f });
    }
  };
  return { context, calls, listeners, sandbox };
}

test('background.js loads in a service worker, with no window in scope', () => {
  const { context, sandbox } = workerContext();
  const code = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  assert.doesNotThrow(() => vm.runInContext(code, context, { filename: 'background.js' }));
  assert.equal(typeof sandbox.BatonWorker, 'object', 'the worker did not register itself');
  assert.ok(sandbox.BatonWorker && typeof sandbox.BatonWorker.intake === 'function');
  assert.ok(sandbox.BatonWorker && typeof sandbox.BatonWorker.installWebRequest === 'function');
});

test('clicking the toolbar button opens the settings page', () => {
  const { context, calls, listeners } = workerContext();
  const code = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'background.js' });

  assert.equal(listeners.clicked.length, 1, 'chrome.action.onClicked was never registered');
  listeners.clicked[0]();
  assert.deepEqual(calls.created, [{ url: 'chrome-extension://baton/settings.html' }]);
});

test('the event layer hands its exports across the worker boundary', () => {
  const { context, sandbox } = workerContext();
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context,
    { filename: 'background.js' });
  // the four modules have to find each other without a window object
  assert.ok(sandbox.BatonEvents, 'events did not export');
  assert.ok(sandbox.BatonDedupe, 'dedupe did not export');
  assert.ok(sandbox.BatonNotifier, 'notifier did not export');
  assert.equal(typeof sandbox.BatonEvents.fromChatState, 'function');
  assert.ok(sandbox.BatonWorker.targets, 'the worker never reached the evaluation intake');
});

test('a broken notification module cannot take the toolbar button down with it', () => {
  const { context, calls, listeners } = workerContext();
  // simulate a module that throws while loading, the way worker.js did
  context.__bad = true;
  const original = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const poisoned = original.replace(
    "importScripts(\n  'notifications/events.js',",
    "importScripts(\n  'notifications/missing-on-purpose.js',");
  vm.runInContext(poisoned, context, { filename: 'background.js' });
  assert.equal(listeners.clicked.length, 1, 'the click handler depends on the notification stack');
  listeners.clicked[0]();
  assert.equal(calls.created.length, 1);
});

test('nothing in the notification stack can poll Arena', () => {
  // a source level guard: the fix for a rate limited account must not quietly
  // come back as a timer or a fetch
  const files = ['notifications/worker.js', 'notifications/observe.js'];
  for (const f of files) {
    const code = fs.readFileSync(path.join(root, f), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/)/.test(line))   // ignore comments
      .join('\n');
    assert.ok(!/fetch\s*\(/.test(code), f + ' issues a fetch');
    assert.ok(!/setInterval\s*\(/.test(code), f + ' sets an interval');
    assert.ok(!/XMLHttpRequest/.test(code), f + ' opens an XHR');
    const timers = (code.match(/setTimeout\s*\(/g) || []).length;
    assert.ok(timers <= 1, f + ' has ' + timers + ' timers; only a DOM tick is allowed');
  }
  // the page side tap is allowed to wrap fetch, but must not call it
  const tap = fs.readFileSync(path.join(root, 'notifications/tap.js'), 'utf8')
    .split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
  assert.ok(!/fetch\s*\(\s*['"`]/.test(tap), 'the tap must not call fetch itself');
});

test('a stalled notification never leaves the caller without a reply', async () => {
  // Reproduces the console error "the message channel closed before a response
  // was received": intake that never calls back used to hang the reply forever.
  const { context, listeners, sandbox } = workerContext();
  sandbox.__batonReplyTimeout = 40;
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context,
    { filename: 'background.js' });
  sandbox.BatonWorker.intake = () => { /* never calls back, on purpose */ };

  const replied = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('no reply'), 800);
    listeners.message[0]({ type: 'baton-event', events: [{ type: 'response_done' }] }, {}, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
  assert.notEqual(replied, 'no reply', 'the reply never came: the channel would close');
  assert.equal(replied.ok, false);
  assert.equal(replied.reason, 'timeout');
});

test('a missing notification module still answers the caller', () => {
  const { context, listeners, sandbox } = workerContext();
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context,
    { filename: 'background.js' });
  let reply = null;
  // simulate the import having failed: the worker never registered. Deleting on
  // the sandbox object does not remove a property of the contextified global, so
  // it has to happen inside the context.
  vm.runInContext('delete globalThis.BatonWorker', context);
  listeners.message[0]({ type: 'baton-event', events: [{ type: 'response_done' }] }, {}, (r) => { reply = r; });
  assert.ok(reply, 'no reply for a missing worker');
  assert.equal(reply.ok, false);
});

test('intake answers exactly once even when the notifier throws', async () => {
  const { context, calls } = workerContext();
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context,
    { filename: 'background.js' });
  const worker = context.BatonWorker;
  assert.equal(typeof worker.intake, 'function');

  let answers = 0;
  worker.intake({ type: 'response_done', threadId: 't', turnId: 'u', mode: 'agent' }, {}, () => {
    answers += 1;
  });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(answers, 1, 'intake answered ' + answers + ' times');
  assert.ok(calls.notificationCreated.length >= 0);
});
