/* Shared helpers for the download counter.
 *
 * Everything here is server side. The Neon database is reached over its HTTP
 * endpoint, so this file needs no driver and no package.json next to it.
 * Nothing in here is ever sent to the browser except the numbers it computes.
 */

const SQL_ENDPOINT_RE = /^(postgres(?:ql)?):\/\/([^@]+)@([^/:]+)(?::(\d+))?\/([^?]+)/i;

function parseConnectionString(raw) {
  const value = String(raw || '').trim();
  const match = SQL_ENDPOINT_RE.exec(value);
  if (!match) return null;
  return { host: match[3], database: match[5] };
}

/**
 * Runs one statement over Neon's HTTP endpoint.
 *
 * Returns { rows, rowCount }. Throws on a transport or SQL error so the caller
 * can answer 503 rather than pretending a write happened.
 */
async function sql(query, params = []) {
  const connectionString = process.env.BATON_DATABASE_URL;
  const target = parseConnectionString(connectionString);
  if (!target) {
    throw new Error('BATON_DATABASE_URL is missing or not a postgres connection string');
  }

  const res = await fetch(`https://${target.host}/sql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'neon-connection-string': connectionString,
    },
    body: JSON.stringify({ query, params }),
  });

  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`database answered ${res.status} with a non-JSON body`);
  }
  if (!res.ok) {
    throw new Error(payload.message || `database answered ${res.status}`);
  }
  return { rows: payload.rows || [], rowCount: payload.rowCount || 0 };
}

/** The visitor's address as Vercel's edge saw it. Vercel sets x-real-ip. */
function clientIp(headers = {}) {
  const real = String(headers['x-real-ip'] || '').trim();
  if (real) return real;
  const forwarded = String(headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || '';
}

/** Country code the edge already resolved. No lookup, no extra request. */
function clientCountry(headers = {}) {
  const raw = String(headers['x-vercel-ip-country'] || headers['cf-ipcountry'] || '')
    .trim()
    .toUpperCase();
  return /^[A-Z]{2}$/.test(raw) ? raw : '';
}

function classifyBrowser(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return 'unknown';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'other';
}

function cleanText(value, max) {
  return String(value == null ? '' : value)
    .replace(/[^\w.\-+/ ]/g, '')
    .trim()
    .slice(0, max);
}

function cleanVersion(value) {
  const raw = String(value == null ? '' : value).trim().slice(0, 24);
  return /^[0-9A-Za-z.\-+]{1,24}$/.test(raw) ? raw : '';
}

/** Compares two strings without leaking their length through timing. */
function sameSecret(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!right || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

module.exports = {
  sql,
  clientIp,
  clientCountry,
  classifyBrowser,
  cleanText,
  cleanVersion,
  sameSecret,
  json,
  readBody,
};
