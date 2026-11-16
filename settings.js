/* The settings page: the same panel the on-page gear opens, on a full page,
   plus the update flow that only works from an extension page. */
(async () => {
  const mount = document.getElementById('mount');
  if (!window.BatonPanel) return;
  const panel = await window.BatonPanel.mount(mount);
  await wireUpdates(panel);
})();

const REPO = 'sarang-cmd/baton';

function currentVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch (_) {
    return '0';
  }
}

async function wireUpdates(panel) {
  const updater = window.BatonUpdater;
  if (!updater) return;

  const { now, pick } = panel.updateButtons();

  const describeFolder = (folder) => {
    if (!folder || !folder.linked) return 'No folder is linked, so Baton cannot update itself yet.';
    if (folder.permission !== 'granted') {
      return `Folder "${folder.folderName}" is linked but Chrome wants permission again.`;
    }
    return `Updating writes into "${folder.folderName}".`;
  };

  const runApply = async () => {
    if (now) now.disabled = true;
    panel.updateStatus('Downloading and checking the update...');
    try {
      const result = await updater.applyUpdate({});
      panel.updateStatus(
        `Wrote ${result.files} files for version ${result.version} into "${result.folderName}". ` +
          'Open chrome://extensions and press reload on Baton, because Chrome will not restart an unpacked extension by itself.',
        'good'
      );
    } catch (error) {
      panel.updateStatus(`Update failed: ${error.message} Nothing was written.`, 'bad');
    } finally {
      if (now) now.disabled = false;
    }
  };

  const runLink = async () => {
    if (pick) pick.disabled = true;
    panel.updateStatus('Waiting for you to pick the unzipped Baton folder...');
    try {
      const result = await updater.linkFolder();
      panel.updateStatus(
        `Linked "${result.folderName}". Press Update in place next time a release appears.`,
        'good'
      );
      if (now) now.hidden = false;
      if (pick) pick.hidden = true;
    } catch (error) {
      panel.updateStatus(
        error && error.name === 'AbortError' ? 'No folder picked.' : `Could not link: ${error.message}`,
        'bad'
      );
    } finally {
      if (pick) pick.disabled = false;
    }
  };

  if (now) now.addEventListener('click', runApply);
  if (pick) pick.addEventListener('click', runLink);

  const result = await updater.checkForUpdate({});
  if (!result.ok) {
    panel.updateStatus(
      `Could not check for updates: ${result.error} You can still get the zip from the site.`,
      'bad'
    );
    return;
  }

  if (result.available) {
    panel.showUpdate({ ...result.latest, folder: result.folder });
    panel.updateStatus(describeFolder(result.folder));
  } else {
    panel.updateStatus(`Baton ${currentVersion()} is the newest version. ${describeFolder(result.folder)}`);
  }

  // One quiet line a day so the stats page can show how many installs are out
  // there. It goes to Baton's own site, never to Arena.
  updater.checkin();
}
