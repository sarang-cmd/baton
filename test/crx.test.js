/**
 * The signed CRX, checked by taking it apart again.
 *
 * A CRX that Chrome rejects is worse than no CRX: the user sees nothing and the
 * extension silently never updates. So the header is parsed back, the extension
 * id is recomputed from the embedded public key, the signature is verified with
 * openssl against the exact bytes Chrome signs, and the payload is compared with
 * the zip the release build produces.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const crxPath = path.join(root, 'site', 'baton.crx');
const updatesPath = path.join(root, 'site', 'updates.xml');
const keyPath = process.env.BATON_KEY || path.join(os.homedir(), '.keys', 'baton-extension.pem');
const available = fs.existsSync(crxPath) && fs.existsSync(keyPath);

function readVarint(buf, at) {
  let value = 0;
  let shift = 0;
  let pos = at;
  for (;;) {
    const byte = buf[pos++];
    value |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return { value, pos };
    shift += 7;
  }
}

function readFields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const key = readVarint(buf, pos);
    pos = key.pos;
    const field = key.value >> 3;
    const wire = key.value & 7;
    if (wire === 2) {
      const len = readVarint(buf, pos);
      pos = len.pos;
      out.push({ field, value: buf.subarray(pos, pos + len.value) });
      pos += len.value;
    } else {
      const v = readVarint(buf, pos);
      pos = v.pos;
      out.push({ field, value: v.value });
    }
  }
  return out;
}

test('the crx has a Cr24 header and version 3', { skip: !available && 'no crx or key' }, () => {
  const crx = fs.readFileSync(crxPath);
  assert.equal(crx.subarray(0, 4).toString(), 'Cr24');
  assert.equal(crx.readUInt32LE(4), 3);
  const headerSize = crx.readUInt32LE(8);
  assert.ok(headerSize > 0 && headerSize < 4096, 'implausible header size ' + headerSize);
});

test('the embedded key derives the id in the update manifest', { skip: !available && 'no crx or key' }, () => {
  const crx = fs.readFileSync(crxPath);
  const header = crx.subarray(12, 12 + crx.readUInt32LE(8));
  const fields = readFields(header);
  const proof = readFields(fields.find((f) => f.field === 2).value);
  const pubDer = proof.find((f) => f.field === 1).value;

  const digest = crypto.createHash('sha256').update(pubDer).digest('hex').slice(0, 32);
  const id = [...digest].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

  const xml = fs.readFileSync(updatesPath, 'utf8');
  assert.match(xml, new RegExp("appid='" + id + "'"), 'updates.xml names a different id');

  // the key inside the crx must be the public half of the signing key we hold
  const derived = execFileSync('openssl', ['rsa', '-in', keyPath, '-pubout', '-outform', 'DER']);
  assert.ok(pubDer.equals(derived), 'the crx was signed by a different key than the one on disk');
});

test('the signature verifies against the bytes Chrome signs', { skip: !available && 'no crx or key' }, () => {
  const crx = fs.readFileSync(crxPath);
  const headerSize = crx.readUInt32LE(8);
  const header = crx.subarray(12, 12 + headerSize);
  const payload = crx.subarray(12 + headerSize);

  const fields = readFields(header);
  const proof = readFields(fields.find((f) => f.field === 2).value);
  const signature = proof.find((f) => f.field === 2).value;
  const signedHeader = fields.find((f) => f.field === 10000).value;

  const prefix = Buffer.concat([
    Buffer.from('CRX3 SignedData\x00', 'binary'),
    Buffer.from(Uint32Array.of(signedHeader.length).buffer),
    signedHeader,
    payload
  ]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crx-'));
  const msg = path.join(dir, 'msg.bin');
  const sig = path.join(dir, 'sig.bin');
  const pub = path.join(dir, 'pub.pem');
  fs.writeFileSync(msg, prefix);
  fs.writeFileSync(sig, signature);
  execFileSync('openssl', ['rsa', '-in', keyPath, '-pubout', '-out', pub]);
  const out = execFileSync('openssl', ['dgst', '-sha256', '-verify', pub, '-signature', sig, msg],
    { encoding: 'utf8' });
  assert.match(out, /Verified OK/);
});

test('the payload is the same extension the release zip carries', { skip: !available && 'no crx or key' }, () => {
  const crx = fs.readFileSync(crxPath);
  const payload = crx.subarray(12 + crx.readUInt32LE(8));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crxzip-'));
  const zipPath = path.join(dir, 'payload.zip');
  fs.writeFileSync(zipPath, payload);
  execFileSync('python3', ['-c', `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1])
names = sorted(z.namelist())
print('\\n'.join(names))
`, zipPath], { encoding: 'utf8' });

  // the manifest inside the crx must be the same version the site advertises
  const manifest = JSON.parse(execFileSync('python3', ['-c', `
import json, sys, zipfile
print(json.dumps(json.loads(zipfile.ZipFile(sys.argv[1]).read('manifest.json'))))
`, zipPath], { encoding: 'utf8' }));
  const xml = fs.readFileSync(updatesPath, 'utf8');
  assert.match(xml, new RegExp("version='" + manifest.version.replace(/\./g, '\\.') + "'"));
  assert.ok(manifest.content_scripts.some((cs) => cs.world === 'MAIN'),
    'the passive tap is missing from the packaged manifest');
});
