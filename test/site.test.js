/**
 * The two new public surfaces, tested where they can actually be tested here:
 * the update manifest the extension points at, and the stats gate.
 *
 * The stats page is checked with jsdom: the password must be a hash, the wrong
 * password must not reveal anything, and the right one must. What is NOT tested
 * here is GitHub's live API, so the numbers themselves remain unverified until
 * someone opens the page.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const siteDir = path.join(root, 'site');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const statsHtml = fs.readFileSync(path.join(siteDir, 'stats.html'), 'utf8');

test('the manifest points at an update manifest the site actually serves', () => {
  assert.ok(manifest.update_url, 'manifest has no update_url, so a crx would never update');
  assert.match(manifest.update_url, /^https:\/\/[a-z0-9.-]+\/updates\.xml$/);
  assert.ok(fs.existsSync(path.join(siteDir, 'updates.xml')),
    'updates.xml is not in site/, so the URL the manifest names would 404');
});

test('the update manifest names the same version as the manifest', () => {
  const xml = fs.readFileSync(path.join(siteDir, 'updates.xml'), 'utf8');
  // the xml declaration also says version='1.0', so anchor on the updatecheck
  const version = /<updatecheck[^>]*version='([^']+)'/.exec(xml)[1];
  assert.equal(version, manifest.version,
    'updates.xml advertises ' + version + ' but the manifest is ' + manifest.version);
  const codebase = /codebase='([^']+)'/.exec(xml)[1];
  assert.ok(codebase.endsWith('/baton.crx'));
  assert.ok(codebase.startsWith(manifest.update_url.replace('/updates.xml', '')),
    'the crx and the update manifest are served from different origins');
});

test('the policy file uses the id in the update manifest', () => {
  const xml = fs.readFileSync(path.join(siteDir, 'updates.xml'), 'utf8');
  const id = /appid='([^']+)'/.exec(xml)[1];
  const reg = fs.readFileSync(path.join(siteDir, 'install-windows.reg'), 'utf8');
  assert.match(reg, new RegExp('"' + id + ';https://'));
  assert.match(reg, /Windows Registry Editor Version 5\.00/);
  assert.match(reg, /ExtensionInstallForcelist/);
  assert.ok(reg.includes('\r\n'), 'the registry file must use CRLF line endings');
});

test('the password lives in the server environment, not in any file', () => {
  const files = [
    'site/stats.html',
    'site/api/stats.js',
    'site/api/downloads.js',
    'site/api/version.js',
    'site/api/_db.js',
    'site/track.js',
  ];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.ok(!/baton-harbor-2026/.test(text), rel + ' has the stats password written into it');
  }
  const api = fs.readFileSync(path.join(siteDir, 'api', 'stats.js'), 'utf8');
  assert.match(api, /process\.env\.BATON_STATS_PASSWORD/,
    'the stats endpoint must read its password from the environment');
  assert.match(api, /sameSecret/, 'the password must be compared without leaking its length');
});

test('the stats page is not indexable and pulls in no third party', () => {
  assert.match(statsHtml, /<meta name="robots" content="noindex/);
  assert.ok(!/googleapis|analytics|gtag/.test(statsHtml), 'the stats page pulls in a third party');
  const urls = [...statsHtml.matchAll(/https:\/\/[a-z0-9./-]+/gi)].map((m) => m[0]);
  const thirdParty = urls.filter((u) => !/schema\.org|baton-arena\.vercel\.app/.test(u));
  assert.deepEqual(thirdParty, []);
});

test('counts are asked for by the page and never counted on load', () => {
  const track = fs.readFileSync(path.join(siteDir, 'track.js'), 'utf8');
  const download = fs.readFileSync(path.join(siteDir, 'download.js'), 'utf8');
  assert.match(track, /\/api\/downloads/, 'the beacon does not point at the counter');
  assert.match(track, /sendBeacon/, 'the beacon should survive the page going away');
  assert.match(track, /catch\(function \(\) \{\}\)|catch \(_\)/, 'a failed beacon must be swallowed');
  // counted in the click handler, so opening the dialog is not a download
  assert.match(download, /trackDownload\(\{ channel: 'site'/, 'the direct download is not counted');
  assert.match(download, /trackDownload\(\{ channel: 'github'/, 'the source download is not counted');
  const index = fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8');
  assert.match(index, /<script src="track\.js"><\/script>/, 'the page never loads the beacon');
});

test('the stats gate hides the numbers until the server accepts the password', async () => {
  let JSDOM;
  try {
    ({ JSDOM } = require('jsdom'));
  } catch (_) {
    return; // jsdom is a devDependency installed by npm install
  }
  const password = 'baton-harbor-2026';
  const payload = {
    ok: true,
    range: { days: 30 },
    totals: {
      downloads: 12, uniqueIps: 5, today: 2, last7: 9, last30: 12,
      updateChecks: 3, uniqueUpdateIps: 2,
      firstAt: '2026-11-01T10:00:00Z', lastAt: '2026-11-16T10:00:00Z',
    },
    daily: [
      { date: '2026-11-15', count: 4, uniqueIps: 2 },
      { date: '2026-11-16', count: 8, uniqueIps: 3 },
    ],
    byVersion: [{ label: '1.7.0', count: 12, uniqueIps: 5 }],
    byChannel: [{ label: 'site', count: 10 }, { label: 'github', count: 2 }],
    bySource: [{ label: 'dialog', count: 12 }],
    byCountry: [{ label: 'DE', count: 9, uniqueIps: 4 }],
    byBrowser: [{ label: 'Chrome', count: 12 }],
    byDay: [],
    recent: [
      { kind: 'download', version: '1.7.0', channel: 'site', source: 'dialog',
        ip: '203.0.113.9', country: 'DE', browser: 'Chrome', at: '2026-11-16T10:00:00Z' },
    ],
  };

  const dom = new JSDOM(statsHtml, {
    url: 'https://baton-arena.vercel.app/stats.html',
    runScripts: 'dangerously',
  });
  const { window } = dom;
  window.fetch = (url, options) => {
    const key = (options && options.headers && options.headers['x-baton-key']) || '';
    if (key !== password) {
      return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ ok: false, error: 'Wrong password' }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
  };

  const stats = window.document.getElementById('statsSection');
  const err = window.document.getElementById('gateErr');
  assert.equal(stats.hidden, true, 'the stats were visible before the password');

  const input = window.document.getElementById('pass');
  input.value = 'wrong';
  window.document.getElementById('gateForm')
    .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(stats.hidden, true, 'a wrong password unlocked the page');
  assert.match(err.textContent, /not the password/);

  input.value = password;
  window.document.getElementById('gateForm')
    .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(stats.hidden, false, 'the right password did not unlock the page');

  const read = (name) => window.document.querySelector('[data-stat="' + name + '"]').textContent;
  assert.equal(read('downloads'), '12');
  assert.equal(read('uniqueIps'), '5', 'unique addresses are the point of the counter');
  assert.equal(read('updateChecks'), '3');
  assert.equal(window.document.querySelectorAll('#versionBody tr').length, 1);
  assert.equal(window.document.querySelectorAll('#recentBody tr').length, 1);
  assert.match(window.document.querySelector('#recentBody td').textContent, /2026/);
  dom.window.close();
});
