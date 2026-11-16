/**
 * The tap, tested as a page would exercise it.
 *
 * Two properties matter and both are load bearing:
 *   1. it adds no request: the page's own call is wrapped, not repeated
 *   2. the answer text does not cross into the extension, only its length
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'notifications', 'tap.js'), 'utf8');
const CHAT_ID = '01a1bb6e-5c5b-76c5-9350-505e2afea7aa';

function pageContext(body, contentType = 'application/json') {
  const posted = [];
  const counts = { fetch: 0 };
  const sandbox = {
    location: { origin: 'https://arena.ai' },
    postMessage: (msg) => posted.push(msg),
    JSON,
    console,
    setTimeout
  };
  sandbox.window = sandbox;
  sandbox.fetch = function countedFetch() {
    counts.fetch += 1;
    return Promise.resolve({
      ok: true,
      headers: { get: () => contentType },
      clone() {
        return { text: () => Promise.resolve(JSON.stringify(body)) };
      },
      json: () => Promise.resolve(body)
    });
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { sandbox, posted, counts };
}

const chatBody = {
  id: CHAT_ID,
  messages: [
    { id: 'm1', role: 'user', metadata: { pending: false }, parts: [{ type: 'text', text: 'a private prompt' }] },
    { id: 'm2', role: 'assistant', metadata: { pending: true },
      parts: [{ type: 'step-start' }, { type: 'text', state: 'streaming', text: 'a private answer' }] }
  ]
};

test('the tap does not add a request of its own', async () => {
  const { sandbox, counts } = pageContext(chatBody);
  await sandbox.fetch('https://arena.ai/api/chat/' + CHAT_ID);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(counts.fetch, 1, 'the page call was counted once, so the tap repeated nothing');
});

test('the tap hands over structure and drops the text', async () => {
  const { sandbox, posted } = pageContext(chatBody);
  await sandbox.fetch('https://arena.ai/api/chat/' + CHAT_ID);
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(posted.length, 1);
  assert.equal(posted[0].kind, 'chat');
  const payload = posted[0].payload;
  assert.equal(payload.messages.length, 2);
  assert.equal(payload.messages[1].metadata.pending, true);
  assert.equal(payload.messages[1].parts[1].state, 'streaming');
  assert.equal(payload.messages[1].parts[1].textLength, 'a private answer'.length);

  const everything = JSON.stringify(posted);
  assert.ok(!everything.includes('a private prompt'), 'the prompt crossed the boundary');
  assert.ok(!everything.includes('a private answer'), 'the answer crossed the boundary');
});

test('a non JSON response is ignored', async () => {
  const { sandbox, posted } = pageContext(chatBody, 'text/event-stream');
  await sandbox.fetch('https://arena.ai/api/chat/' + CHAT_ID);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(posted.length, 0);
});

test('an unrelated request is ignored', async () => {
  const { sandbox, posted } = pageContext(chatBody);
  await sandbox.fetch('https://arena.ai/api/history/unified?limit=20');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(posted.length, 0);
});

test('an evaluation status is passed on with its message id', async () => {
  const { sandbox, posted } = pageContext({ status: 'ready' });
  await sandbox.fetch('https://arena.ai/api/evaluation/webdev/' + CHAT_ID);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].kind, 'evaluation');
  assert.deepEqual(posted[0].payload, { messageId: CHAT_ID, status: 'ready' });
});

test('malformed JSON does not throw out of the wrapper', async () => {
  const { sandbox, posted } = pageContext(chatBody);
  await sandbox.fetch('https://arena.ai/api/chat/' + CHAT_ID);
  await new Promise((r) => setTimeout(r, 30));
  assert.doesNotThrow(() => posted.forEach((p) => JSON.stringify(p)));
});

test('the XHR path is wrapped as well as fetch', () => {
  const sandbox = {
    location: { origin: 'https://arena.ai' },
    postMessage: () => {},
    JSON,
    console,
    XMLHttpRequest: function XMLHttpRequest() {}
  };
  sandbox.window = sandbox;
  sandbox.XMLHttpRequest.prototype = { open() {}, send() {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  assert.notEqual(sandbox.XMLHttpRequest.prototype.open.name, 'open', 'open was not wrapped');
  assert.notEqual(sandbox.XMLHttpRequest.prototype.send.name, 'send', 'send was not wrapped');
});
