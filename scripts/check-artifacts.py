#!/usr/bin/env python3
"""Checks that the artifacts under site/ were built from the tree in front of you.

    bash scripts/build.sh && python3 scripts/check-artifacts.py

CI has no signing key, so it cannot re-sign the crx. What it can do is prove the
things that drift: that site/baton.zip is the exact archive dist/baton packs to,
that releases.json describes those bytes and no others, and that the versions in
the manifest, the update manifest and releases.json agree.

Exit code 1 with a message saying which of those broke.
"""
import hashlib
import importlib.util
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, 'site')


def load_make_crx():
    path = os.path.join(ROOT, 'scripts', 'make-crx.py')
    spec = importlib.util.spec_from_file_location('make_crx', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read(rel):
    with open(os.path.join(ROOT, rel), 'rb') as fh:
        return fh.read()


def main():
    problems = []

    manifest = json.loads(read('manifest.json'))
    version = manifest['version']

    dist = os.path.join(ROOT, 'dist', 'baton')
    if not os.path.isdir(dist):
        print('dist/baton is missing. Run bash scripts/build.sh first.')
        return 1

    packed = load_make_crx().pack_zip(dist)
    served = read('site/baton.zip')
    if packed != served:
        problems.append(
            'site/baton.zip is not what dist/baton packs to. Run bash scripts/build.sh '
            'and python3 scripts/make-crx.py, then commit both.'
        )

    releases = json.loads(read('site/releases.json'))
    if releases.get('version') != version:
        problems.append('releases.json says %r, manifest.json says %r'
                        % (releases.get('version'), version))
    if releases.get('zip', {}).get('sha256') != hashlib.sha256(served).hexdigest():
        problems.append('releases.json advertises a zip checksum that does not match site/baton.zip')
    if releases.get('zip', {}).get('size') != len(served):
        problems.append('releases.json advertises a zip size that does not match site/baton.zip')

    crx = read('site/baton.crx')
    if releases.get('crx', {}).get('sha256') != hashlib.sha256(crx).hexdigest():
        problems.append('releases.json advertises a crx checksum that does not match site/baton.crx')
    if releases.get('crx', {}).get('size') != len(crx):
        problems.append('releases.json advertises a crx size that does not match site/baton.crx')

    # the crx payload sits after the header, and it must be the same archive
    if crx[:4] == b'Cr24':
        header_len = int.from_bytes(crx[8:12], 'little')
        payload = crx[12 + header_len:]
        if payload != served:
            problems.append('the payload inside site/baton.crx is not site/baton.zip, so one of '
                            'them is stale or they were signed from different trees')
    else:
        problems.append('site/baton.crx is not a CRX3 file')

    xml = read('site/updates.xml').decode('utf-8')
    marker = "version='%s'" % version
    if marker not in xml:
        problems.append('site/updates.xml does not announce %s' % version)

    if problems:
        for p in problems:
            print('FAIL', p)
        return 1

    print('artifacts agree: version %s, zip %d bytes, crx %d bytes'
          % (version, len(served), len(crx)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
