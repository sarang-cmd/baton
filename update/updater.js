/* Baton's unpacked-folder updater.
 *
 * Chrome will not update an extension loaded from a folder, so Baton updates
 * itself the way the lm-subs extension does: it asks this project's own release
 * endpoint what the newest version is, downloads the release zip, verifies it
 * against a SHA-256 that was published next to it plus a CRC-32 per entry, and
 * writes the files straight into the folder the user linked once through the
 * File System Access API. The folder handle lives in IndexedDB, so linking is a
 * one-time step.
 *
 * Two rules this file keeps:
 *   1. Every request goes to baton-arena.vercel.app and nowhere else. Baton still
 *      sends nothing to Arena.
 *   2. Nothing is written until a person asks for it. There is no silent write
 *      and no reload of the extension, because Chrome forbids the latter anyway.
 */
(function () {
  const UPDATE_BASE = 'https://baton-arena.vercel.app';
  const IDB_NAME = 'baton_updater';
  const IDB_STORE = 'handles';
  const IDB_DIR_KEY = 'extension_root_dir';
  const CHECK_MS = 12 * 60 * 60 * 1000;
  const CHECKIN_MS = 24 * 60 * 60 * 1000;

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function compareSemver(a, b) {
    const parse = (v) =>
      String(v || '0.0.0')
        .replace(/^v/i, '')
        .split('-')[0]
        .split('.')
        .map((n) => Number.parseInt(n, 10) || 0);
    const pa = parse(a);
    const pb = parse(b);
    for (let i = 0; i < 3; i += 1) {
      const diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    }
    return 0;
  }

  function isNewer(remote, local) {
    return compareSemver(remote, local) > 0;
  }

  function currentVersion() {
    try {
      return chrome.runtime.getManifest().version;
    } catch (_) {
      return '0.0.0';
    }
  }

  async function sha256Hex(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  async function inflateRaw(compressed) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('This browser cannot unpack the update here. Use the zip instead.');
    }
    const stream = new DecompressionStream('deflate-raw');
    const writer = stream.writable.getWriter();
    writer.write(compressed);
    writer.close();
    const buffer = await new Response(stream.readable).arrayBuffer();
    return new Uint8Array(buffer);
  }

  function safePath(rawName) {
    const normalized = String(rawName || '').replace(/\\/g, '/').trim();
    if (!normalized || normalized.endsWith('/')) return null;
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
      throw new Error('The update contains an absolute path and was rejected.');
    }
    const parts = normalized.split('/').filter(Boolean);
    if (parts.some((p) => p === '.' || p === '..')) {
      throw new Error('The update contains a parent path and was rejected.');
    }
    if (parts.length > 1 && parts[0] === 'baton') return parts.slice(1).join('/');
    return parts.join('/');
  }

  /* Reads the central directory, never trusts the local headers for sizes, and
     checks the CRC of every entry it inflates. */
  async function extractZip(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    let eocd = -1;
    const floor = Math.max(0, bytes.byteLength - 65557);
    for (let pos = bytes.byteLength - 22; pos >= floor; pos -= 1) {
      if (view.getUint32(pos, true) === 0x06054b50) {
        eocd = pos;
        break;
      }
    }
    if (eocd < 0) throw new Error('The download is not a zip file.');

    const total = view.getUint16(eocd + 10, true);
    const start = view.getUint32(eocd + 16, true);
    const decoder = new TextDecoder('utf-8');
    const files = [];
    let cursor = start;

    for (let i = 0; i < total; i += 1) {
      if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== 0x02014b50) {
        throw new Error('The zip central directory is damaged.');
      }
      const method = view.getUint16(cursor + 10, true);
      const expectedCrc = view.getUint32(cursor + 16, true);
      const compressedSize = view.getUint32(cursor + 20, true);
      const uncompressedSize = view.getUint32(cursor + 24, true);
      const nameLen = view.getUint16(cursor + 28, true);
      const extraLen = view.getUint16(cursor + 30, true);
      const commentLen = view.getUint16(cursor + 32, true);
      const localAt = view.getUint32(cursor + 42, true);
      const rawName = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));
      cursor += 46 + nameLen + extraLen + commentLen;

      const path = safePath(rawName);
      if (!path) continue;

      if (localAt + 30 > bytes.byteLength || view.getUint32(localAt, true) !== 0x04034b50) {
        throw new Error(`The zip entry for ${path} has no local header.`);
      }
      const localNameLen = view.getUint16(localAt + 26, true);
      const localExtraLen = view.getUint16(localAt + 28, true);
      const dataStart = localAt + 30 + localNameLen + localExtraLen;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > bytes.byteLength) throw new Error(`The zip entry for ${path} is cut short.`);

      const slice = bytes.subarray(dataStart, dataEnd);
      let out;
      if (method === 0) out = new Uint8Array(slice);
      else if (method === 8) out = await inflateRaw(slice);
      else throw new Error(`Unsupported compression method ${method} for ${path}.`);

      if (out.byteLength !== uncompressedSize) {
        throw new Error(`Wrong size after unpacking ${path}.`);
      }
      if (crc32(out) !== expectedCrc) {
        throw new Error(`Integrity check failed for ${path}.`);
      }
      files.push({ path, bytes: out });
    }

    if (!files.some((f) => f.path === 'manifest.json')) {
      throw new Error('The update has no manifest.json, so it is not Baton.');
    }
    return files;
  }

  function openDb() {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
  }

  async function saveHandle(handle) {
    const db = await openDb();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(handle, IDB_DIR_KEY);
        tx.oncomplete = () => {
          db.close();
          resolve(true);
        };
        tx.onerror = () => {
          db.close();
          resolve(false);
        };
      } catch (_) {
        db.close();
        resolve(false);
      }
    });
  }

  async function loadHandle() {
    const db = await openDb();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(IDB_DIR_KEY);
        req.onsuccess = () => {
          db.close();
          resolve(req.result || null);
        };
        req.onerror = () => {
          db.close();
          resolve(null);
        };
      } catch (_) {
        db.close();
        resolve(null);
      }
    });
  }

  async function forgetHandle() {
    const db = await openDb();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(IDB_DIR_KEY);
        tx.oncomplete = () => {
          db.close();
          resolve(true);
        };
        tx.onerror = () => {
          db.close();
          resolve(false);
        };
      } catch (_) {
        db.close();
        resolve(false);
      }
    });
  }

  async function permissionOf(handle) {
    if (!handle) return 'none';
    try {
      return (await handle.queryPermission({ mode: 'readwrite' })) || 'granted';
    } catch (_) {
      return 'prompt';
    }
  }

  /* Must be called from a click: Chrome only grants write access to a picked
     folder inside a user gesture. */
  async function linkFolder() {
    if (typeof window.showDirectoryPicker !== 'function') {
      throw new Error('This browser has no folder picker. Use the zip instead.');
    }
    const picked = await window.showDirectoryPicker({ id: 'baton-root', mode: 'readwrite' });
    let target = picked;
    try {
      await picked.getFileHandle('manifest.json', { create: false });
    } catch (_) {
      try {
        const nested = await picked.getDirectoryHandle('baton', { create: false });
        await nested.getFileHandle('manifest.json', { create: false });
        target = nested;
      } catch (_) {
        throw new Error('That folder has no manifest.json. Pick the unzipped Baton folder.');
      }
    }
    await saveHandle(target);
    return { folderName: target.name || 'baton', permission: await permissionOf(target) };
  }

  async function folderStatus() {
    const handle = await loadHandle();
    if (!handle) return { linked: false, permission: 'none', folderName: '' };
    return {
      linked: true,
      permission: await permissionOf(handle),
      folderName: handle.name || 'baton',
    };
  }

  async function requestAccess() {
    const handle = await loadHandle();
    if (!handle) throw new Error('No folder is linked yet.');
    const granted = await handle.requestPermission({ mode: 'readwrite' });
    if (granted !== 'granted') throw new Error('Write access to the folder was refused.');
    return true;
  }

  async function writeFiles(handle, files) {
    await requestAccess();
    const writeInto = async (dir) => {
      for (const file of files) {
        const parts = file.path.split('/').filter(Boolean);
        const name = parts.pop();
        let cursor = dir;
        for (const part of parts) {
          cursor = await cursor.getDirectoryHandle(part, { create: true });
        }
        const fileHandle = await cursor.getFileHandle(name, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(file.bytes);
        await writable.close();
      }
    };
    await writeInto(handle);
    return files.length;
  }

  async function fetchLatest() {
    const res = await fetch(`${UPDATE_BASE}/api/version`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`The update server answered ${res.status}.`);
    const data = await res.json();
    if (!data || !data.ok || !data.version) throw new Error('The update server sent no version.');
    return data;
  }

  /**
   * Asks the release endpoint whether a newer build exists. Cached in storage so
   * opening the settings page twice does not mean two requests.
   */
  async function checkForUpdate({ force = false } = {}) {
    const local = currentVersion();
    const cached = await new Promise((resolve) => {
      try {
        chrome.storage.local.get(['batonUpdateCheck'], (res) =>
          resolve((res && res.batonUpdateCheck) || null)
        );
      } catch (_) {
        resolve(null);
      }
    });

    let latest = null;
    if (!force && cached && Date.now() - (cached.at || 0) < CHECK_MS) {
      latest = cached.latest;
    } else {
      try {
        const data = await fetchLatest();
        latest = {
          version: data.version,
          notes: data.notes || '',
          publishedAt: data.publishedAt || '',
          zip: data.zip || null,
          downloadUrl: `${UPDATE_BASE}/baton.zip`,
        };
        try {
          chrome.storage.local.set({ batonUpdateCheck: { at: Date.now(), latest } });
        } catch (_) {}
      } catch (error) {
        if (cached && cached.latest) latest = cached.latest;
        else return { ok: false, error: error.message || 'Could not reach the update server.' };
      }
    }

    const status = await folderStatus();
    return {
      ok: true,
      local,
      latest,
      available: Boolean(latest && isNewer(latest.version, local)),
      folder: status,
    };
  }

  /**
   * Downloads the zip, verifies it, and writes it into the linked folder.
   * Returns what changed, so the page can tell the person to reload.
   */
  async function applyUpdate({ expectedSha256 = '', expectedVersion = '' } = {}) {
    const handle = await loadHandle();
    if (!handle) {
      const error = new Error('No folder is linked yet. Choose the Baton folder first.');
      error.code = 'NOT_LINKED';
      throw error;
    }

    const info = await fetchLatest();
    const hash = String(expectedSha256 || (info.zip && info.zip.sha256) || '');
    const target = String(expectedVersion || (info.zip && info.zip.version) || info.version || '');
    if (!hash) throw new Error('The update server published no checksum, so nothing was written.');

    const res = await fetch(`${UPDATE_BASE}/baton.zip`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Downloading the update failed with ${res.status}.`);
    const bytes = new Uint8Array(await res.arrayBuffer());

    const actual = await sha256Hex(bytes);
    if (actual !== String(hash).toLowerCase()) {
      throw new Error('The download does not match its published checksum. Nothing was written.');
    }

    const files = await extractZip(bytes);
    const manifestEntry = files.find((f) => f.path === 'manifest.json');
    const manifest = JSON.parse(new TextDecoder().decode(manifestEntry.bytes));
    if (target && manifest.version !== target) {
      throw new Error(
        `The zip says ${manifest.version} but the server said ${target}. Nothing was written.`
      );
    }

    const written = await writeFiles(handle, files);
    try {
      chrome.storage.local.set({
        batonLastUpdate: { at: Date.now(), version: manifest.version, files: written },
      });
    } catch (_) {}

    return { ok: true, version: manifest.version, files: written, folderName: handle.name || 'baton' };
  }

  /**
   * One line telling the update endpoint this install exists, at most once a
   * day. No address of the visitor is kept by the extension: the site records
   * what its own edge sees, exactly as it does for a download.
   */
  async function checkin() {
    const last = await new Promise((resolve) => {
      try {
        chrome.storage.local.get(['batonCheckinAt'], (res) => resolve((res && res.batonCheckinAt) || 0));
      } catch (_) {
        resolve(0);
      }
    });
    if (Date.now() - Number(last || 0) < CHECKIN_MS) return false;
    try {
      await fetch(`${UPDATE_BASE}/api/downloads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'update',
          version: currentVersion(),
          channel: 'update',
          source: 'extension',
        }),
      });
      chrome.storage.local.set({ batonCheckinAt: Date.now() });
      return true;
    } catch (_) {
      return false;
    }
  }

  window.BatonUpdater = {
    BASE: UPDATE_BASE,
    compareSemver,
    isNewer,
    currentVersion,
    sha256Hex,
    crc32,
    extractZip,
    linkFolder,
    folderStatus,
    forgetHandle,
    requestAccess,
    checkForUpdate,
    applyUpdate,
    checkin,
  };
})();
