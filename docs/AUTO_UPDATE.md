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
