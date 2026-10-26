// Nova → Glance: fetches Joe's schedule for the Together tab.
// The phone sends its backup passcode here; this function calls Glance's /api/share with the
// shared key on the phone's behalf, so the key never leaves the server.
//
// GET /api/partner?from=YYYY-MM-DD&to=YYYY-MM-DD   (to not included, 120 days max)
// Env vars: NOVA_PASSCODE, SHARE_KEY, PARTNER_URL
//
// 200 { ok:true, data }   data = Glance's answer: { v, app, name:'Joe', tz, known_through, items }
// 200 { ok:false, state, message }   state: not_setup · key_mismatch · sharing_off · not_ready · unreachable · bad_answer
// 401 wrong passcode · 400 bad range

const crypto = require('crypto');

const MAX_DAYS = 120, TIMEOUT_MS = 9000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function realDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number), t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
const dayNum = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };

const MESSAGES = {
  not_setup: 'Together is not set up on Nova yet. It needs SHARE_KEY and PARTNER_URL.',
  key_mismatch: 'Nova and Glance have different sharing keys.',
  sharing_off: 'Joe has sharing turned off.',
  not_ready: 'Glance is not sharing yet.',
  unreachable: 'Could not reach Glance.',
  bad_answer: 'Glance sent back something Nova does not understand.'
};
const fail = (res, state) => res.status(200).json({ ok: false, state, message: MESSAGES[state] });

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const pass = process.env.NOVA_PASSCODE;
  if (!pass) return res.status(500).json({ error: 'Server is missing NOVA_PASSCODE' });
  if (!safeEqual(req.headers['x-nova-passcode'] || '', pass)) return res.status(401).json({ error: 'Wrong passcode' });

  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const from = q.from, to = q.to;
  if (!realDate(from) || !realDate(to)) return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });
  const span = dayNum(to) - dayNum(from);
  if (span < 1 || span > MAX_DAYS) return res.status(400).json({ error: `to must be 1 to ${MAX_DAYS} days after from` });

  const key = process.env.SHARE_KEY, partner = (process.env.PARTNER_URL || '').trim().replace(/\/+$/, '');
  if (!key || !partner) return fail(res, 'not_setup');

  let r;
  try {
    r = await fetch(`${partner}/api/share?from=${from}&to=${to}`, {
      headers: { 'x-share-key': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (e) {
    console.error('nova partner fetch failed:', e.name, e.message);
    return fail(res, 'unreachable');
  }
  if (r.status === 401) return fail(res, 'key_mismatch');
  if (r.status === 403) return fail(res, 'sharing_off');
  if (r.status === 404 || r.status === 503) return fail(res, 'not_ready');
  if (!r.ok) { console.error('nova partner status:', r.status); return fail(res, 'unreachable'); }

  let data;
  try { data = await r.json(); } catch (e) { return fail(res, 'bad_answer'); }
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return fail(res, 'bad_answer');
  return res.status(200).json({
    ok: true,
    data: {
      v: data.v, app: data.app, name: typeof data.name === 'string' && data.name ? data.name : 'Joe', tz: data.tz,
      known_through: typeof data.known_through === 'string' && DATE_RE.test(data.known_through) ? data.known_through : null,
      items: data.items.slice(0, 5000)
    }
  });
};
