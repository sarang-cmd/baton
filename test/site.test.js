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

test('the stats page never contains the password in plain text', () => {
  assert.ok(!/baton-harbor-2026/.test(statsHtml), 'the password is written into the page');
  const digest = /const PASS_SHA256 = '([0-9a-f]{64})'/.exec(statsHtml);
  assert.ok(digest, 'the page does not hold a sha256 of the password');
  const expected = crypto.createHash('sha256').update('baton-harbor-2026').digest('hex');
  assert.equal(digest[1], expected, 'the hash does not match the documented password');
});

test('the stats page is not indexable and needs no extra permission', () => {
  assert.match(statsHtml, /<meta name="robots" content="noindex/);
  assert.ok(!/googleapis|analytics|gtag/.test(statsHtml), 'the stats page pulls in a third party');
  // it talks to GitHub and nothing else
  const urls = [...statsHtml.matchAll(/https:\/\/[a-z0-9./-]+/gi)].map((m) => m[0]);
  const thirdParty = urls.filter((u) => !/github\.com|schema\.org|baton-arena\.vercel\.app/.test(u));
  assert.deepEqual(thirdParty, []);
});

test('the stats gate hides the numbers until the password is right', async () => {
  let JSDOM;
  try {
    ({ JSDOM } = require('jsdom'));
  } catch (_) {
    return; // jsdom is a devDependency installed by npm install
  }
  const dom = new JSDOM(statsHtml, { url: 'https://baton-arena.vercel.app/stats.html', runScripts: 'dangerously' });
  const { window } = dom;
  // jsdom has no crypto.subtle by default in all versions; supply it from node
  if (!window.crypto || !window.crypto.subtle) {
    Object.defineProperty(window, 'crypto', { value: crypto.webcrypto });
  }
  window.fetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve([
      { tag_name: 'v1.5.1', published_at: '2026-11-16T00:00:00Z', draft: false,
        assets: [{ name: 'baton.zip', download_count: 7 }, { name: 'baton.crx', download_count: 3 }] },
      { tag_name: 'v1.5.0', published_at: '2026-11-15T00:00:00Z', draft: false,
        assets: [{ name: 'baton.zip', download_count: 11 }] }
    ])
  });

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

  input.value = 'baton-harbor-2026';
  window.document.getElementById('gateForm')
    .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(stats.hidden, false, 'the right password did not unlock the page');
  const total = window.document.querySelector('[data-stat="total"]').textContent;
  assert.equal(total, '21', 'the totals are wrong: got ' + total);
  const crx = window.document.querySelector('[data-stat="crx"]').textContent;
  assert.equal(crx, '3', 'crx downloads should be counted separately');
  assert.equal(window.document.querySelectorAll('#relBody tr').length, 2);
  dom.window.close();
});
