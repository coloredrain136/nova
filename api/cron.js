// Nova notification sweep. Supabase runs this every 5 minutes (see 6-notify-job.sql).
// It works out which reminders are due, sends each one once, and remembers what it sent.
// Header: Authorization: Bearer <CRON_SECRET>
// Env vars: SUPABASE_URL, SUPABASE_SECRET_KEY, CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT,
//           and for the Together heads-up: SHARE_KEY, PARTNER_URL

process.env.TZ = process.env.NOVA_TZ || 'America/Detroit';   // all the date math below is Irina's local time

const crypto = require('crypto');
const { supa } = require('./_lib/supa');
const { ready, sendAll } = require('./_lib/send');
const { dueNow, fmtRange } = require('./_lib/notify');
const { shareItems, TG } = require('./_lib/shared');

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
const pad = n => String(n).padStart(2, '0');
const ds = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return ds(new Date(y, m - 1, d + n)); };
const hm = ms => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };

// "You and Joe are both free today": ask Glance for Joe's day and run the same math as the Together tab
async function togetherText(date, data, prefs) {
  const key = process.env.SHARE_KEY, partner = (process.env.PARTNER_URL || '').trim().replace(/\/+$/, '');
  if (!key || !partner) return null;
  const from = addDays(date, -1), to = addDays(date, 1);
  const r = await fetch(`${partner}/api/share?from=${from}&to=${to}`, { headers: { 'x-share-key': key }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) return null;
  const his = await r.json();
  if (!his || !Array.isArray(his.items)) return null;
  const mine = shareItems({ types: data.types, shifts: data.shifts, events: data.events, skips: data.skips, from, to });
  const o = { weeks: 4, minH: 3, h0: 9, h1: 23, sleep: 14, ...((prefs && prefs.together) || {}) };
  const [y, m, d] = date.split('-').map(Number);
  const res = TG.plan({
    items: TG.fromShare(mine, 'me').concat(TG.fromShare(his.items, 'them')),
    from: new Date(y, m - 1, d).getTime(), days: 1, now: Date.now(),
    through: { me: null, them: his.known_through || null }, opt: { h0: o.h0, h1: o.h1, minH: o.minH, sleep: o.sleep }
  });
  const D = res.days[0];
  if (!D || (D.kind !== 'full' && D.kind !== 'free')) return null;
  const h24 = !!(prefs && prefs.appearance && prefs.appearance.time24);
  const name = his.name || 'Joe';
  const mins = Math.round(D.len / 60e3), len = `${Math.floor(mins / 60)}h${mins % 60 ? ' ' + (mins % 60) + 'm' : ''}`;
  return D.kind === 'full'
    ? { title: `Day off together with ${name}`, body: `You're both free today, ${fmtRange(hm(D.a), hm(D.b), h24)}.` }
    : { title: `You and ${name} are both free today`, body: `${D.label}, ${fmtRange(hm(D.a), hm(D.b), h24)} (${len}).` };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET is not set' });
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!safeEqual(auth, secret)) return res.status(401).json({ error: 'Unauthorized' });
  if (!ready()) return res.status(503).json({ error: 'VAPID keys are not set' });
  const db = supa();
  if (!db) return res.status(500).json({ error: 'Server is missing its Supabase env vars' });

  try {
    const now = Date.now(), today = ds(new Date(now));
    const subs = await db.get('nova_push_subs?select=endpoint,p256dh,auth');
    if (!subs.length) return res.status(200).json({ ok: true, sent: 0, note: 'No phones have notifications turned on' });

    const [settings, types, shifts, events, skips, log] = await Promise.all([
      db.get('nova_settings?select=prefs&id=eq.main'),
      db.get('nova_shift_types?select=id,name,start_time,end_time,together,remind'),
      db.get(`nova_shifts?select=date,shift_type_id&date=gte.${addDays(today, -2)}&date=lte.${addDays(today, 9)}&limit=1000`),
      db.get(`nova_events?select=id,title,date,start_time,end_time,all_day,repeat,repeat_until,remind&date=lte.${addDays(today, 9)}&limit=5000`),
      db.get(`nova_event_skips?select=event_id,date&date=gte.${addDays(today, -2)}&date=lte.${addDays(today, 9)}&limit=5000`),
      db.get(`nova_notif_log?select=key&sent_at=gte.${new Date(now - 3 * 864e5).toISOString()}&limit=5000`)
    ]);
    const prefs = (settings[0] && settings[0].prefs) || {};
    const data = { types, shifts, events, skips };
    const due = dueNow({ now, prefs, ...data, sent: new Set(log.map(l => l.key)) });

    for (const n of due) {
      if (!n.together) continue;
      let t = null;
      try { t = await togetherText(n.date, data, prefs); } catch (e) { console.error('nova together heads-up:', e.message); }
      if (t) Object.assign(n, t); else n.skip = true;
    }
    const send = due.filter(n => !n.skip);
    const results = [];
    for (const n of send) {
      // Claim the key first so two overlapping sweeps can't both send it
      const claimed = await db.insertIgnore('nova_notif_log', [{ key: n.key }], 'key');
      if (!claimed.length) continue;
      const r = await sendAll(db, subs, { title: n.title, body: n.body, tag: n.key.split('|')[0], url: '/' });
      results.push({ key: n.key, ...r });
    }
    // Housekeeping: forget sends older than two weeks
    if (new Date(now).getMinutes() < 5) await db.del(`nova_notif_log?sent_at=lt.${new Date(now - 14 * 864e5).toISOString()}`);
    return res.status(200).json({ ok: true, checked: due.length, sent: results.length, results });
  } catch (e) {
    console.error('nova cron error:', e.message);
    return res.status(500).json({ error: 'Sweep failed' });
  }
};
