/* GET /api/stats?days=30
 *
 * The whole dashboard in one response, gated on BATON_STATS_PASSWORD. The
 * password is compared on the server, so unlike the old page the numbers are
 * not sitting in a public JSON file waiting to be read with developer tools.
 *
 * The key travels in an x-baton-key header, never in the URL, so it does not
 * end up in a referrer or a proxy log.
 */

const { sql, sameSecret, json } = require('./_db');

const CONFIGURED = () => String(process.env.BATON_STATS_PASSWORD || '').length > 0;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    return json(res, 405, { ok: false, error: 'Method not allowed' });
  }

  if (!CONFIGURED()) {
    return json(res, 503, {
      ok: false,
      error: 'No stats password is configured on the server',
      hint: 'Set BATON_STATS_PASSWORD in the Vercel project environment.',
    });
  }

  const key = req.headers['x-baton-key'] || '';
  if (!sameSecret(key, process.env.BATON_STATS_PASSWORD)) {
    return json(res, 401, { ok: false, error: 'Wrong password' });
  }

  const requested = Number.parseInt(req.query?.days, 10);
  const days = Math.min(365, Math.max(1, Number.isFinite(requested) ? Math.trunc(requested) : 30));

  try {
    const [totals, daily, byVersion, byChannel, bySource, byCountry, byBrowser, byDay, recent] =
      await Promise.all([
        sql(
          `select count(*)::int as downloads,
                  count(distinct ip)::int as unique_ips,
                  count(*) filter (where occurred_at >= date_trunc('day', now()))::int as today,
                  count(*) filter (where occurred_at >= now() - interval '7 days')::int as last7,
                  count(*) filter (where occurred_at >= now() - interval '30 days')::int as last30,
                  count(*) filter (where kind = 'update')::int as update_checks,
                  count(distinct ip) filter (where kind = 'update')::int as unique_update_ips,
                  min(occurred_at) as first_at,
                  max(occurred_at) as last_at
           from baton_events`
        ),
        sql(
          `select to_char(d.day, 'YYYY-MM-DD') as date,
                  count(e.id)::int as count,
                  count(distinct e.ip)::int as unique_ips
           from generate_series(
                  date_trunc('day', now()) - (($1::int - 1) * interval '1 day'),
                  date_trunc('day', now()),
                  interval '1 day'
                ) as d(day)
           left join baton_events e
             on e.occurred_at >= d.day
            and e.occurred_at < d.day + interval '1 day'
           group by d.day
           order by d.day`,
          [days]
        ),
        sql(
          `select coalesce(nullif(version, ''), 'unknown') as label,
                  count(*)::int as count,
                  count(distinct ip)::int as unique_ips
           from baton_events
           group by 1
           order by count desc, label asc
           limit 20`
        ),
        sql(
          `select coalesce(nullif(channel, ''), 'unknown') as label,
                  count(*)::int as count
           from baton_events
           group by 1
           order by count desc, label asc`
        ),
        sql(
          `select coalesce(nullif(source, ''), 'direct') as label,
                  count(*)::int as count
           from baton_events
           group by 1
           order by count desc, label asc
           limit 20`
        ),
        sql(
          `select coalesce(nullif(country, ''), 'unknown') as label,
                  count(*)::int as count,
                  count(distinct ip)::int as unique_ips
           from baton_events
           group by 1
           order by count desc, label asc
           limit 20`
        ),
        sql(
          `select coalesce(nullif(browser, ''), 'unknown') as label,
                  count(*)::int as count
           from baton_events
           group by 1
           order by count desc, label asc`
        ),
        sql(
          `select to_char(occurred_at, 'YYYY-MM-DD') as date, kind, count(*)::int as count
           from baton_events
           where occurred_at >= now() - interval '90 days'
           group by 1, 2
           order by 1 desc`,
          []
        ),
        sql(
          `select kind, version, channel, source, host(ip) as ip, country, browser,
                  to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at
           from baton_events
           order by occurred_at desc
           limit 25`
        ),
      ]);

    const row = totals.rows[0] || {};
    return json(res, 200, {
      ok: true,
      range: { days },
      totals: {
        downloads: Number(row.downloads) || 0,
        uniqueIps: Number(row.unique_ips) || 0,
        today: Number(row.today) || 0,
        last7: Number(row.last7) || 0,
        last30: Number(row.last30) || 0,
        updateChecks: Number(row.update_checks) || 0,
        uniqueUpdateIps: Number(row.unique_update_ips) || 0,
        firstAt: row.first_at || null,
        lastAt: row.last_at || null,
      },
      daily: daily.rows.map((r) => ({
        date: r.date,
        count: Number(r.count) || 0,
        uniqueIps: Number(r.unique_ips) || 0,
      })),
      byVersion: byVersion.rows.map((r) => ({
        label: r.label,
        count: Number(r.count) || 0,
        uniqueIps: Number(r.unique_ips) || 0,
      })),
      byChannel: byChannel.rows.map((r) => ({ label: r.label, count: Number(r.count) || 0 })),
      bySource: bySource.rows.map((r) => ({ label: r.label, count: Number(r.count) || 0 })),
      byCountry: byCountry.rows.map((r) => ({
        label: r.label,
        count: Number(r.count) || 0,
        uniqueIps: Number(r.unique_ips) || 0,
      })),
      byBrowser: byBrowser.rows.map((r) => ({ label: r.label, count: Number(r.count) || 0 })),
      byDay: byDay.rows.map((r) => ({ date: r.date, kind: r.kind, count: Number(r.count) || 0 })),
      recent: recent.rows.map((r) => ({
        kind: r.kind,
        version: r.version,
        channel: r.channel,
        source: r.source,
        ip: r.ip,
        country: r.country,
        browser: r.browser,
        at: r.at,
      })),
    });
  } catch (error) {
    return json(res, 503, { ok: false, error: 'Stats unavailable', detail: String(error.message || '') });
  }
};
