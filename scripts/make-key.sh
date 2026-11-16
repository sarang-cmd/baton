#!/usr/bin/env bash
# Create the extension signing key, once.
#
# The key IS the extension id: lose it and every install has to be redone, leak
# it and anyone can sign an update for that id. So it is written outside the
# repository, never committed, and should be backed up somewhere private.
set -euo pipefail

KEY_DIR="${1:-$HOME/.keys}"
KEY="$KEY_DIR/baton-extension.pem"

mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"

if [ -f "$KEY" ]; then
  echo "A key already exists at $KEY."
  echo "Refusing to replace it: that would change the extension id and break every install."
  echo "Delete it yourself if you really mean to start over."
  exit 1
fi

openssl genrsa -out "$KEY" 2048 2>/dev/null
chmod 600 "$KEY"

ID=$(python3 - "$KEY" <<'PY'
import hashlib, subprocess, sys
der = subprocess.run(['openssl', 'rsa', '-in', sys.argv[1], '-pubout', '-outform', 'DER'],
                     capture_output=True, check=True).stdout
digest = hashlib.sha256(der).hexdigest()[:32]
print(''.join(chr(ord('a') + int(c, 16)) for c in digest))
PY
)

echo "Key written to $KEY"
echo "Extension id: $ID"
echo
echo "Back this file up somewhere private. Do not commit it."
