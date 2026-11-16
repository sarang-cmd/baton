/**
 * The counting endpoints, driven directly.
 *
 * Each handler is called like Vercel calls it, with the database replaced by a
 * stub, so the parts that decide what is stored and who may read it are checked
 * without a network. The SQL itself is written against a real Neon project, so
 * what stays unverified here is the database, not the routing or the gate.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const apiDir = path.join(root, 'site', 'api');

process.env.BATON_DATABASE_URL =
  'postgresql://user:secret@db.example.test:5432/neondb?sslmode=require';

const calls = [];
let respond = () => ({ rows: [], rowCount: 0 });
const realFetch = global.fetch;

function stubFetch() {
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    const payload = respond(String(url), JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    };
  };
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(chunk) {
      this.body = chunk;
    },
  };
  res.json = () => JSON.parse(res.body);
  return res;
}

function req({ method = 'POST', headers = {}, body = {}, query = {} } = {}) {
  return { method, headers, body, query };
}

function freshRequire(name) {
  const file = path.join(apiDir, name);
  delete require.cache[require.resolve(file)];
  return require(file);
}

test.after(() => {
  global.fetch = realFetch;
});

test('a download without an address is refused rather than counted blind', async () => {
  stubFetch();
  const handler = freshRequire('downloads.js');
  const res = fakeRes();
  await handler(req({ headers: {} }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0, 'nothing should reach the database without an address');
});

test('a download stores the address, the country and the browser family', async () => {
  calls.length = 0;
  stubFetch();
  respond = () => ({ rows: [{ id: 1 }], rowCount: 1 });
  const handler = freshRequire('downloads.js');
  const res = fakeRes();
  await handler(
    req({
      headers: {
        'x-real-ip': '203.0.113.9',
        'x-vercel-ip-country': 'de',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/131.0.0.0 Safari/537.36',
      },
      body: { version: '1.7.0', channel: 'site', source: 'dialog' },
    }),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, recorded: true });
  const sent = calls[0].body;
  assert.deepEqual(sent.params, ['download', '1.7.0', 'site', 'dialog', '203.0.113.9', 'DE', 'Chrome']);
  assert.match(sent.query, /interval '10 seconds'/, 'the ten second dedupe window is missing');
  assert.match(sent.query, /insert into baton_events/i);
});

test('a made up channel cannot widen what the table accepts', async () => {
  calls.length = 0;
  stubFetch();
  const handler = freshRequire('downloads.js');
  const res = fakeRes();
  await handler(
    req({
      headers: { 'x-real-ip': '203.0.113.10' },
      body: { channel: 'DROP TABLE', kind: 'evil', version: 'not a version!' },
    }),
    res
  );
  assert.equal(res.statusCode, 200);
  const sent = calls[0].body;
  assert.equal(sent.params[0], 'download', 'an unknown kind must fall back to download');
  assert.equal(sent.params[2], 'site', 'an unknown channel must fall back to site');
  assert.equal(sent.params[1], '', 'a version with spaces must be dropped, not stored');
});

test('the first address in x-forwarded-for is the visitor', async () => {
  calls.length = 0;
  stubFetch();
  const handler = freshRequire('downloads.js');
  const res = fakeRes();
  await handler(
    req({ headers: { 'x-forwarded-for': '198.51.100.4, 10.0.0.1, 10.0.0.2' }, body: {} }),
    res
  );
  assert.equal(calls[0].body.params[4], '198.51.100.4');
});

test('a database that is down answers 503 instead of pretending to count', async () => {
  global.fetch = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  const handler = freshRequire('downloads.js');
  const res = fakeRes();
  await handler(req({ headers: { 'x-real-ip': '203.0.113.11' }, body: {} }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().ok, false);
});

test('the stats endpoint refuses to run without a configured password', async () => {
  delete process.env.BATON_STATS_PASSWORD;
  const handler = freshRequire('stats.js');
  const res = fakeRes();
  await handler(req({ method: 'GET' }), res);
  assert.equal(res.statusCode, 503);
  assert.match(res.json().error, /password/i);
});

test('the stats endpoint refuses a wrong password and never reaches the database', async () => {
  calls.length = 0;
  stubFetch();
  process.env.BATON_STATS_PASSWORD = 'baton-harbor-2026';
  const handler = freshRequire('stats.js');
  const res = fakeRes();
  await handler(req({ method: 'GET', headers: { 'x-baton-key': 'wrong' } }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(calls.length, 0, 'a wrong password must not cost a query');
  delete process.env.BATON_STATS_PASSWORD;
});

test('the right password returns the whole dashboard', async () => {
  calls.length = 0;
  process.env.BATON_STATS_PASSWORD = 'baton-harbor-2026';
  respond = (url, body) => {
    const query = body.query;
    if (/as downloads,/.test(query)) {
      return {
        rows: [
          {
            downloads: 12,
            unique_ips: 5,
            today: 2,
            last7: 9,
            last30: 12,
            update_checks: 3,
            unique_update_ips: 2,
            first_at: '2026-11-01 10:00:00+00',
            last_at: '2026-11-16 10:00:00+00',
          },
        ],
        rowCount: 1,
      };
    }
    if (/generate_series/.test(query)) {
      return { rows: [{ date: '2026-11-16', count: 2, unique_ips: 2 }], rowCount: 1 };
    }
    if (/host\(ip\)/.test(query)) {
      return {
        rows: [
          {
            kind: 'download',
            version: '1.7.0',
            channel: 'site',
            source: 'dialog',
            ip: '203.0.113.9',
            country: 'DE',
            browser: 'Chrome',
            at: '2026-11-16T10:00:00Z',
          },
        ],
        rowCount: 1,
      };
    }
    if (/group by 1, 2/.test(query)) return { rows: [], rowCount: 0 };
    return { rows: [{ label: '1.7.0', count: 12, unique_ips: 5 }], rowCount: 1 };
  };

  const handler = freshRequire('stats.js');
  const res = fakeRes();
  await handler(
    req({ method: 'GET', headers: { 'x-baton-key': 'baton-harbor-2026' }, query: { days: '30' } }),
    res
  );
  assert.equal(res.statusCode, 200);
  const data = res.json();
  assert.equal(data.ok, true);
  assert.equal(data.totals.downloads, 12);
  assert.equal(data.totals.uniqueIps, 5, 'unique addresses must be reported, not just a total');
  assert.equal(data.totals.updateChecks, 3);
  assert.equal(data.daily.length, 1);
  assert.equal(data.byVersion[0].label, '1.7.0');
  assert.equal(data.recent[0].ip, '203.0.113.9');
  assert.equal(data.range.days, 30);
  assert.ok(calls.length >= 8, 'the dashboard needs every aggregate in one response');
  delete process.env.BATON_STATS_PASSWORD;
});

test('the requested range is clamped to something a database can answer', async () => {
  calls.length = 0;
  process.env.BATON_STATS_PASSWORD = 'x';
  respond = () => ({ rows: [], rowCount: 0 });
  const handler = freshRequire('stats.js');

  const wide = fakeRes();
  await handler(req({ method: 'GET', headers: { 'x-baton-key': 'x' }, query: { days: '99999' } }), wide);
  assert.equal(wide.json().range.days, 365);

  const narrow = fakeRes();
  await handler(req({ method: 'GET', headers: { 'x-baton-key': 'x' }, query: { days: '-4' } }), narrow);
  assert.equal(narrow.json().range.days, 1);
  delete process.env.BATON_STATS_PASSWORD;
});

test('the version endpoint serves what the release build wrote', async () => {
  const handler = freshRequire('version.js');
  const res = fakeRes();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 200);
  const data = res.json();
  const releases = JSON.parse(fs.readFileSync(path.join(root, 'site', 'releases.json'), 'utf8'));
  assert.equal(data.version, releases.version);
  assert.equal(data.zip.sha256, releases.zip.sha256);
  assert.ok(data.zip.url.endsWith('/baton.zip'));
});

test('the endpoints only answer the methods they declare', async () => {
  const downloads = freshRequire('downloads.js');
  const getRes = fakeRes();
  await downloads({ method: 'GET', headers: {} }, getRes);
  assert.equal(getRes.statusCode, 405);

  const version = freshRequire('version.js');
  const postRes = fakeRes();
  await version({ method: 'POST', headers: {} }, postRes);
  assert.equal(postRes.statusCode, 405);
});

test('the stats page no longer carries the numbers in a public file', () => {
  const html = fs.readFileSync(path.join(root, 'site', 'stats.html'), 'utf8');
  assert.ok(html.includes('/api/stats'), 'the page must read from the gated endpoint');
  assert.ok(!/api\.github\.com/.test(html), 'the page still reads GitHub directly');
  assert.ok(!/PASS_SHA256/.test(html), 'the old client side hash gate is still in the page');
  // the key travels in a header, so it never lands in a URL or a proxy log
  assert.match(html, /x-baton-key/);
  assert.ok(!/\/api\/stats\?[^'"]*key=/.test(html), 'the password must not be a query parameter');
  assert.match(html, /<meta name="robots" content="noindex/);
});
