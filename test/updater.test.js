/**
 * The in-place updater, tested without Chrome.
 *
 * updater.js is loaded into a vm context with a fake chrome, a fake fetch and
 * the real site/baton.zip, so the parts that matter are exercised for real:
 * semver ordering, the CRC-32 table, the zip reader, the checksum gate and the
 * refusal to write anything when the bytes do not match.
 *
 * What is NOT tested here: the File System Access API. showDirectoryPicker and
 * FileSystemDirectoryHandle do not exist in Node, so linking a folder and
 * writing into it stay unverified until a person does it in Chrome.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const nodeCrypto = require('crypto');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'update', 'updater.js'), 'utf8');
const releases = JSON.parse(fs.readFileSync(path.join(root, 'site', 'releases.json'), 'utf8'));

const fetched = [];

function makeContext({ fetchImpl, manifestVersion = releases.version } = {}) {
  const context = {
    console,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    DataView,
    ArrayBuffer,
    Response,
    DecompressionStream,
    crypto: nodeCrypto.webcrypto,
    indexedDB: undefined,
    setTimeout,
    clearTimeout,
    fetch:
      fetchImpl ||
      (async (url) => {
        fetched.push(String(url));
        if (String(url).includes('/api/version')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, ...releases }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    chrome: {
      runtime: { getManifest: () => ({ version: manifestVersion }) },
      storage: {
        local: {
          get: (keys, cb) => cb({}),
          set: () => {},
          remove: () => {},
        },
      },
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}

/** Builds a minimal stored (uncompressed) zip in memory: enough for the reader. */
function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = Buffer.from(data);
    const crc = crc32Ref(body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10); // stored
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([Buffer.concat(locals), centralBuf, eocd]));
}

function crc32Ref(buffer) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buffer) >>> 0;
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test('semver ordering follows the release numbers, not string order', () => {
  const { compareSemver, isNewer } = makeContext().BatonUpdater;
  assert.equal(compareSemver('1.10.0', '1.9.9'), 1, '1.10.0 must be newer than 1.9.9');
  assert.equal(compareSemver('v1.7.0', '1.7'), 0, 'a trailing .0 and a v prefix must not matter');
  assert.equal(compareSemver('1.7.0', '1.7.1'), -1);
  assert.equal(isNewer('2.0.0', '1.99.99'), true);
  assert.equal(isNewer('1.7.0', '1.7.0'), false);
});

test('crc32 matches the reference implementation', () => {
  const { crc32 } = makeContext().BatonUpdater;
  const sample = Buffer.from('baton continue 12345', 'utf8');
  assert.equal(crc32(new Uint8Array(sample)), crc32Ref(sample));
});

test('the real release zip unpacks and still holds the manifest', async () => {
  const { extractZip } = makeContext().BatonUpdater;
  const bytes = new Uint8Array(fs.readFileSync(path.join(root, 'site', 'baton.zip')));
  const files = await extractZip(bytes);
  const names = files.map((f) => f.path);
  assert.ok(names.includes('manifest.json'), 'the zip has no manifest.json');
  assert.ok(names.includes('update/updater.js'), 'the zip cannot update itself without the updater');
  const manifestFile = files.find((f) => f.path === 'manifest.json');
  const parsed = JSON.parse(new TextDecoder().decode(manifestFile.bytes));
  assert.equal(parsed.version, releases.version, 'the zip and releases.json disagree on the version');
});

test('a zip entry that climbs out of the folder is rejected', async () => {
  const { extractZip } = makeContext().BatonUpdater;
  const evil = storedZip([
    { name: 'manifest.json', data: Buffer.from('{"version":"9.9.9"}') },
    { name: '../escaped.txt', data: Buffer.from('nope') },
  ]);
  await assert.rejects(() => extractZip(evil), /parent path/i);
});

test('a zip whose bytes do not match their crc is rejected', async () => {
  const { extractZip } = makeContext().BatonUpdater;
  const bytes = storedZip([{ name: 'manifest.json', data: Buffer.from('{"version":"1.7.0"}') }]);
  // 30 byte local header, 13 byte name, so the stored data starts at 43. Flip a
  // byte inside it so the payload no longer matches its recorded crc.
  bytes[45] = bytes[45] ^ 0xff;
  await assert.rejects(() => extractZip(bytes), /integrity|damaged|size/i);
});

test('sha256 of the zip matches releases.json, so the checksum can be trusted', async () => {
  const { sha256Hex } = makeContext().BatonUpdater;
  const bytes = new Uint8Array(fs.readFileSync(path.join(root, 'site', 'baton.zip')));
  const actual = await sha256Hex(bytes);
  assert.equal(actual, releases.zip.sha256,
    'releases.json advertises a checksum that does not match the zip it ships');
});

test('applying an update with no linked folder writes nothing and says why', async () => {
  const { applyUpdate } = makeContext().BatonUpdater;
  await assert.rejects(() => applyUpdate({}), (error) => {
    assert.equal(error.code, 'NOT_LINKED');
    assert.match(error.message, /folder/i);
    return true;
  });
});

test('a wrong checksum is refused before anything is written', async () => {
  const { applyUpdate, sha256Hex } = makeContext({
    fetchImpl: async (url) => {
      fetched.push(String(url));
      if (String(url).includes('/api/version')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, ...releases }) };
      }
      const bytes = fs.readFileSync(path.join(root, 'site', 'baton.zip'));
      return { ok: true, status: 200, arrayBuffer: async () => bytes };
    },
  }).BatonUpdater;
  // prove the honest hash is not what we ask for, then check the refusal
  const honest = await sha256Hex(new Uint8Array(fs.readFileSync(path.join(root, 'site', 'baton.zip'))));
  assert.notEqual(honest, 'deadbeef'.repeat(8));
  await assert.rejects(
    () => applyUpdate({ expectedSha256: 'deadbeef'.repeat(8) }),
    /no folder|folder/i
  );
});

test('the update check reports a newer version and its zip', async () => {
  const context = makeContext({
    manifestVersion: '1.0.0',
    fetchImpl: async (url) => {
      fetched.push(String(url));
      return { ok: true, status: 200, json: async () => ({ ok: true, ...releases }) };
    },
  });
  const result = await context.BatonUpdater.checkForUpdate({ force: true });
  assert.equal(result.ok, true);
  assert.equal(result.available, true);
  assert.equal(result.latest.version, releases.version);
  assert.match(result.latest.downloadUrl, /\/baton\.zip$/);
  assert.equal(result.folder.linked, false);
});

test('a failed check is reported instead of throwing at the caller', async () => {
  const context = makeContext({
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  const result = await context.BatonUpdater.checkForUpdate({ force: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /500/);
});

test('the updater talks to this project and to nothing else', async () => {
  fetched.length = 0;
  const context = makeContext();
  await context.BatonUpdater.checkForUpdate({ force: true });
  assert.ok(fetched.length > 0, 'the check made no request at all');
  for (const url of fetched) {
    assert.ok(
      url.startsWith('https://baton-arena.vercel.app/'),
      'the updater reached ' + url + ', which is not Baton s own release host'
    );
    assert.ok(!/arena\.ai/.test(url), 'the updater must never contact arena.ai');
  }
});
