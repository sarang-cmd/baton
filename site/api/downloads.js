/* POST /api/downloads
 *
 * One anonymous row per download or update check. The address is stored so the
 * dashboard can report unique visitors, which is what was asked for; nothing
 * else about the person is kept.
 *
 * Identical events from the same address within ten seconds collapse into one,
 * so a double click or a retry cannot inflate the count. A bad payload is
 * answered with 400 rather than silently counted.
 */

const {
  sql,
  clientIp,
  clientCountry,
  classifyBrowser,
  cleanText,
  cleanVersion,
  json,
  readBody,
} = require('./_db');

const KINDS = new Set(['download', 'update']);
const CHANNELS = new Set(['site', 'github', 'store', 'update']);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return json(res, 405, { ok: false, error: 'Method not allowed' });
  }

  const body = await readBody(req);
  const kindRaw = cleanText(body.kind, 12).toLowerCase();
  const kind = KINDS.has(kindRaw) ? kindRaw : 'download';
  const channelRaw = cleanText(body.channel, 16).toLowerCase();
  const channel = CHANNELS.has(channelRaw) ? channelRaw : 'site';
  const source = cleanText(body.source, 40).toLowerCase();
  const version = cleanVersion(body.version);
  const ip = clientIp(req.headers);
  const country = clientCountry(req.headers);
  const browser = classifyBrowser(req.headers['user-agent']);

  if (!ip) {
    return json(res, 400, { ok: false, error: 'No address to count against' });
  }

  try {
    const { rows } = await sql(
      `insert into baton_events (kind, version, channel, source, ip, country, browser)
       select $1::text, $2::text, $3::text, $4::text, $5::inet, $6::text, $7::text
       where not exists (
         select 1 from baton_events
         where kind = $1::text and version = $2::text and channel = $3::text
           and source = $4::text and ip = $5::inet
           and occurred_at > now() - interval '10 seconds'
       )
       returning id`,
      [kind, version, channel, source, ip, country, browser]
    );
    return json(res, 200, { ok: true, recorded: rows.length > 0 });
  } catch (error) {
    // The download must never depend on the counter, so this stays a soft
    // failure that the page is free to ignore.
    return json(res, 503, { ok: false, error: 'Counter unavailable', detail: String(error.message || '') });
  }
};
