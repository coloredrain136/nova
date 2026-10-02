// Nova backup proxy. The phone never talks to Supabase directly: it sends its passcode
// here, and this function uses the secret key (kept in Vercel env vars) on its behalf.
//
// Env vars: SUPABASE_URL, SUPABASE_SECRET_KEY, NOVA_PASSCODE
// One action: POST { action: 'sync', upserts: {table:[rows]}, deletes: {table:[keys]} }
//   → applies the changes, then returns everything: { data: {table:[rows]} }

const crypto = require('crypto');

const TABLES = {
  shift_types: { name: 'nova_shift_types', pk: ['id'], cols: ['id', 'name', 'label', 'start_time', 'end_time', 'color', 'position'] },
  events: { name: 'nova_events', pk: ['id'], cols: ['id', 'title', 'date', 'start_time', 'end_time', 'all_day', 'notes', 'repeat', 'repeat_until'] },
  shifts: { name: 'nova_shifts', pk: ['date'], cols: ['date', 'shift_type_id'] },
  skips: { name: 'nova_event_skips', pk: ['event_id', 'date'], cols: ['event_id', 'date'] },
  settings: { name: 'nova_settings', pk: ['id'], cols: ['id', 'view', 'week_start'] }
};
const UPSERT_ORDER = ['shift_types', 'events', 'shifts', 'skips', 'settings'];   // parents before children
const DELETE_ORDER = ['skips', 'shifts', 'events', 'shift_types'];               // children before parents
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/, DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SECRET_KEY, pass = process.env.NOVA_PASSCODE;
  if (!base || !key || !pass) return res.status(500).json({ error: 'Server is missing its env vars' });
  if (!safeEqual(req.headers['x-nova-passcode'] || '', pass)) return res.status(401).json({ error: 'Wrong passcode' });

  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Bad JSON' }); } }
  if (body.action !== 'sync') return res.status(400).json({ error: 'Unknown action' });

  const headers = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  const call = async (path, opts = {}) => {
    const r = await fetch(base + '/rest/v1/' + path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path.split('?')[0]} → ${r.status} ${await r.text()}`);
    return r;
  };

  try {
    const upserts = body.upserts || {}, deletes = body.deletes || {};

    for (const t of UPSERT_ORDER) {
      const rows = Array.isArray(upserts[t]) ? upserts[t] : [];
      if (!rows.length) continue;
      const T = TABLES[t];
      const clean = rows.slice(0, 5000).map(r => Object.fromEntries(T.cols.map(c => [c, r[c] === undefined ? null : r[c]])));
      await call(`${T.name}?on_conflict=${T.pk.join(',')}`, {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(clean)
      });
    }

    for (const t of DELETE_ORDER) {
      const keys = Array.isArray(deletes[t]) ? deletes[t] : [];
      if (!keys.length) continue;
      const T = TABLES[t];
      if (t === 'skips') {
        for (const k of keys) {
          if (!k || !ID_RE.test(k.event_id) || !DATE_RE.test(k.date)) continue;
          await call(`${T.name}?event_id=eq.${k.event_id}&date=eq.${k.date}`, { method: 'DELETE' });
        }
      } else {
        const ok = keys.filter(k => typeof k === 'string' && (t === 'shifts' ? DATE_RE : ID_RE).test(k));
        for (let i = 0; i < ok.length; i += 100) {
          const list = ok.slice(i, i + 100).map(k => `"${k}"`).join(',');
          await call(`${T.name}?${T.pk[0]}=in.(${encodeURIComponent(list)})`, { method: 'DELETE' });
        }
      }
    }

    const data = {};
    for (const t of Object.keys(TABLES)) {
      const T = TABLES[t];
      data[t] = [];
      for (let from = 0; ; from += 1000) {
        const r = await call(`${T.name}?select=${T.cols.join(',')}&order=${T.pk.join(',')}&limit=1000&offset=${from}`);
        const page = await r.json();
        data[t].push(...page);
        if (page.length < 1000) break;
      }
    }
    return res.status(200).json({ data });
  } catch (e) {
    console.error('nova db error:', e.message);
    return res.status(500).json({ error: 'Backup failed' });
  }
};
