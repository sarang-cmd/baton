/* GET /api/version
 *
 * What the newest release is, so the extension can offer an update. The file it
 * reads is written by scripts/make-crx.py in the same step that packs the crx,
 * so the version, the hash and the bytes cannot drift apart.
 */

const release = require('../releases.json');
const { json } = require('./_db');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    return json(res, 405, { ok: false, error: 'Method not allowed' });
  }

  res.setHeader('cache-control', 'public, max-age=60, must-revalidate');
  return json(res, 200, {
    ok: true,
    version: release.version,
    notes: release.notes || '',
    publishedAt: release.publishedAt || '',
    zip: release.zip || null,
    crx: release.crx || null,
    minimum: release.minimum || { chrome: '116' },
  });
};
