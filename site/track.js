/* Download counting, site side.
 *
 * Fires one request when a visitor takes a file, and nothing else. The version
 * comes from releases.json so a stale cached page cannot report a version that
 * does not exist. Every failure is swallowed: a blocked counter must never
 * interrupt the download the visitor just asked for.
 */
(function () {
  var VERSION = '';

  // Warm the version once, quietly. No await, no blocking of the click.
  fetch('releases.json', { cache: 'no-store' })
    .then(function (r) {
      return r.ok ? r.json() : null;
    })
    .then(function (data) {
      if (data && typeof data.version === 'string') VERSION = data.version;
    })
    .catch(function () {});

  /**
   * @param {{channel?: string, source?: string, version?: string, kind?: string}} options
   */
  function trackDownload(options) {
    var opts = options || {};
    try {
      var payload = JSON.stringify({
        kind: String(opts.kind || 'download').slice(0, 12),
        version: String(opts.version || VERSION || '').slice(0, 24),
        channel: String(opts.channel || 'site').slice(0, 16),
        source: String(opts.source || '').slice(0, 40),
      });

      if (typeof navigator.sendBeacon === 'function') {
        var queued = navigator.sendBeacon(
          '/api/downloads',
          new Blob([payload], { type: 'application/json' })
        );
        if (queued) return true;
      }

      if (typeof fetch === 'function') {
        fetch('/api/downloads', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
          keepalive: true,
        }).catch(function () {});
        return true;
      }
    } catch (_) {
      // Counting is best effort by design.
    }
    return false;
  }

  window.trackDownload = trackDownload;
  window.baton = window.baton || {};
  window.baton.trackDownload = trackDownload;
})();
