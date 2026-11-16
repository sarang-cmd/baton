#!/usr/bin/env python3
"""Pack the extension into a signed CRX3 and write the update manifest.

    python3 scripts/make-crx.py --key ~/.keys/baton-extension.pem \
        --base https://baton-arena.vercel.app

Writes site/baton.crx and site/updates.xml, and prints the extension id.

Why this exists: Chrome will not update an extension that was loaded unpacked.
A signed CRX plus an update manifest is the only self-hosted way to get silent
updates, and on Windows Chrome only accepts it through the install policy
(see docs/AUTO_UPDATE.md).

The extension id is derived from the public key, so the key file IS the
extension's identity. Losing it changes the id, and every install has to be
redone. Leaking it lets anyone sign an update for that id. Keep it out of the
repository, back it up, and never commit it.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZIP_DATE = (1980, 1, 1, 0, 0, 0)


def run(cmd):
    p = subprocess.run(cmd, capture_output=True)
    if p.returncode:
        raise SystemExit('failed: %s\n%s' % (' '.join(cmd), p.stderr.decode()[:400]))
    return p.stdout


def pack_zip(src_dir):
    """The same deterministic zip the release build uses."""
    files = []
    for root, dirs, names in os.walk(src_dir):
        dirs.sort()
        for n in sorted(names):
            files.append(os.path.join(root, n))
    files.sort()
    buf = tempfile.NamedTemporaryFile(suffix='.zip', delete=False)
    buf.close()
    with zipfile.ZipFile(buf.name, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for path in files:
            arc = os.path.relpath(path, src_dir).replace(os.sep, '/')
            info = zipfile.ZipInfo(arc, date_time=ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o644 & 0xFFFF) << 16
            info.create_system = 3
            with open(path, 'rb') as fh:
                z.writestr(info, fh.read())
    with open(buf.name, 'rb') as fh:
        data = fh.read()
    os.unlink(buf.name)
    return data


def public_key_der(key_path):
    return run(['openssl', 'rsa', '-in', key_path, '-pubout', '-outform', 'DER'])


def extension_id(pub_der):
    digest = hashlib.sha256(pub_der).hexdigest()[:32]
    return ''.join(chr(ord('a') + int(c, 16)) for c in digest)


def varint(value):
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def field(number, wire_type, payload):
    key = varint((number << 3) | wire_type)
    if wire_type == 2:
        return key + varint(len(payload)) + payload
    if wire_type == 0:
        return key + varint(payload)
    raise ValueError('unsupported wire type %d' % wire_type)


def signed_header_data(crx_id):
    # SignedData { optional bytes crx_id = 1; }  (older Chrome uses field 1 as bytes)
    return field(1, 2, crx_id)


def crx3(src_dir, key_path):
    payload = pack_zip(src_dir)
    pub_der = public_key_der(key_path)
    crx_id = hashlib.sha256(pub_der).digest()[:16]
    signed_header = signed_header_data(crx_id)

    # The signature covers this exact prefix, the length, the signed header and
    # the archive. The trailing null in the magic string is part of it.
    signature_input = (b'CRX3 SignedData\x00' + len(signed_header).to_bytes(4, 'little')
                       + signed_header + payload)

    with tempfile.TemporaryDirectory() as tmp:
        msg = os.path.join(tmp, 'sig-input.bin')
        sig = os.path.join(tmp, 'sig.bin')
        with open(msg, 'wb') as fh:
            fh.write(signature_input)
        run(['openssl', 'dgst', '-sha256', '-sign', key_path, '-out', sig, msg])
        with open(sig, 'rb') as fh:
            signature = fh.read()

    proof = field(1, 2, pub_der) + field(2, 2, signature)
    header = field(2, 2, proof) + field(10000, 2, signed_header)
    crx = b'Cr24' + (3).to_bytes(4, 'little') + len(header).to_bytes(4, 'little') + header + payload
    return crx, payload, pub_der


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--key', default=os.path.expanduser('~/.keys/baton-extension.pem'))
    ap.add_argument('--base', default='https://baton-arena.vercel.app',
                    help='public base URL the crx and updates.xml are served from')
    ap.add_argument('--src', default=os.path.join(ROOT, 'dist', 'baton'))
    ap.add_argument('--site', default=os.path.join(ROOT, 'site'))
    args = ap.parse_args()

    if not os.path.exists(args.key):
        raise SystemExit('no signing key at %s. Run scripts/make-key.sh once, and keep it safe.'
                         % args.key)
    if not os.path.isdir(args.src):
        raise SystemExit('%s is missing. Run bash scripts/build.sh first.' % args.src)

    manifest = json.load(open(os.path.join(args.src, 'manifest.json')))
    version = manifest['version']
    crx, payload, pub_der = crx3(args.src, args.key)
    ext_id = extension_id(pub_der)

    os.makedirs(args.site, exist_ok=True)
    crx_path = os.path.join(args.site, 'baton.crx')
    with open(crx_path, 'wb') as fh:
        fh.write(crx)

    base = args.base.rstrip('/')
    updates = (
        "<?xml version='1.0' encoding='UTF-8'?>\n"
        "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n"
        "  <app appid='%s'>\n"
        "    <updatecheck codebase='%s/baton.crx' version='%s' />\n"
        "  </app>\n"
        "</gupdate>\n" % (ext_id, base, version)
    )
    with open(os.path.join(args.site, 'updates.xml'), 'w') as fh:
        fh.write(updates)

    print('extension id %s' % ext_id)
    print('version      %s' % version)
    print('crx          %s (%d bytes)' % (crx_path, len(crx)))
    print('payload zip  %d bytes' % len(payload))
    print('crx sha256   %s' % hashlib.sha256(crx).hexdigest())
    print('update url   %s/updates.xml' % base)


if __name__ == '__main__':
    main()
