# Automatic updates

Baton updates itself only if Chrome is allowed to update it. Chrome does not update extensions that
were loaded unpacked, so this file is about the two ways to stop being unpacked.

## The short version for Windows

1. Install Baton once from the signed package, using the policy file:
   [install-windows.reg](https://baton-arena.vercel.app/install-windows.reg).
   Download it, right click, Merge, accept the administrator prompt, then restart Chrome.
2. Chrome installs Baton by itself within a minute or two of restarting, and from then on checks
   `https://baton-arena.vercel.app/updates.xml` for a new version in the background.
3. Nothing else to do. When a release goes out, the update installs within a few hours, usually
   sooner, and the extension restarts.

To stop this, delete the registry key `HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist`,
or remove just the `"1"` value inside it, and restart Chrome.

## The other path: updating an unpacked folder in place

Chrome cannot update a folder, so from 1.7 Baton does it itself, the same way the lm-subs extension
does. This needs no policy, no administrator, and no registry key.

1. Open the settings page and press **Choose folder**. Pick the unzipped Baton folder, the one with
   `manifest.json` directly inside it. The handle is kept in IndexedDB, so this is done once.
2. When a newer version exists, the update banner gains **Update in place**. Press it.
3. The updater asks `https://baton-arena.vercel.app/api/version` for the newest version, downloads
   `https://baton-arena.vercel.app/baton.zip`, checks the whole file against the published SHA-256,
   unpacks it in memory while checking the CRC-32 of every entry, then writes the files into the
   linked folder.
4. Press reload on `chrome://extensions`. The page says so, because Chrome gives no way for an
   extension to restart itself.

The folder is written, never deleted: files that no longer exist in the new release stay behind. That
is deliberate. An updater that deletes is one bug away from deleting the wrong thing, and stale files
in a folder are harmless when the manifest does not load them.

### What it refuses

| Condition | Result |
| --- | --- |
| No folder linked | Nothing written, error says so |
| SHA-256 does not match the published checksum | Nothing written |
| Zip has an absolute path or a `..` segment | Nothing written |
| Zip has no `manifest.json` | Nothing written |
| Version inside the zip is not the version the server announced | Nothing written |
| CRC-32 mismatch on any entry | Nothing written |

### Where the checksum comes from

`scripts/make-crx.py` writes `site/releases.json` in the same run that packs the crx, and it hashes
the exact archive it just produced. `site/baton.zip` is that same archive, byte for byte, and so is
the payload inside `site/baton.crx`. One build, one hash, three consumers. `/api/version` serves that
file, so a version number, a size and a checksum can never belong to different bytes.

## Why a policy is needed at all

Chrome refuses to install an extension from anywhere other than the Chrome Web Store unless a policy
allows it. That check has no opt out in the UI. The policy file above is the documented path: it tells
Chrome "this specific extension id, from this specific update URL, is allowed, and keep it current".

This works on Windows without a managed domain, but it does need administrator rights on the machine
because it writes under `HKEY_LOCAL_MACHINE`. If you are not an administrator, use the unpacked
install and update by hand, see the last section.

## How the pieces fit

| Piece | Where | What it does |
| --- | --- | --- |
| `baton.crx` | `https://baton-arena.vercel.app/baton.crx` | The signed package Chrome downloads |
| `updates.xml` | `https://baton-arena.vercel.app/updates.xml` | Says which version exists and where the crx is |
| `update_url` | `manifest.json` | Points Chrome at `updates.xml` |
| `install-windows.reg` | `https://baton-arena.vercel.app/install-windows.reg` | The policy that permits the install and the updates |

All four are produced by `scripts/make-crx.py` and committed, so a release is: build, make the crx,
push. Chrome reads `updates.xml`, sees a higher `version`, downloads the crx and verifies its signature
against the key baked into the extension id.

## The extension id, and the one file that must never leak

The id is `oidnlpdhlamfjiohnaddpjamfnkenjpi`. It is derived from the signing key, not from the code, so:

- the key file is the extension's identity. **Losing it changes the id**, and every install has to be
  redone by hand.
- the key file is also the ability to sign an update for that id. **Anyone who has it can ship code to
  every install.** It lives outside the repository, at `~/.keys/baton-extension.pem`, is gitignored,
  and must be backed up somewhere private.

`scripts/make-key.sh` creates a new key once. Never run it again unless you intend to start over.

## Checking an update without waiting

`chrome://extensions` shows the version and a "Update" button in developer mode; for a policy install
the version appears there too. Or open the settings page and read the version under the title.

## If you cannot use a policy

Then Baton stays unpacked, and Chrome will never update it. Use the release page, download the new
zip, and point `chrome://extensions` at the new folder. The `checksum` printed on each release lets you
confirm you got the file the CI built. The extension also tells you when a newer release exists.

## The other way to get real silent updates

The Chrome Web Store. It is the only distribution route that silently updates for ordinary users on
Windows and Mac without touching policy, and it costs a one off developer fee. Nothing about Baton is
store-hostile: no remote code, no analytics, no network destination of its own beyond the GitHub API.
It has simply not been submitted.
