// Nova → Glance: hands Irina's schedule to Joe's app for the Together tab.
// Only Glance's server calls this, with the shared key. Phones never see the key.
//
// GET /api/share?from=YYYY-MM-DD&to=YYYY-MM-DD   (to not included, 120 days max)
// Header x-share-key must equal env SHARE_KEY.
// Env vars: SUPABASE_URL, SUPABASE_SECRET_KEY, SHARE_KEY
//
// 200 { v:1, app:'nova', name:'Irina', tz:'America/Detroit', known_through, items:[{ title, start, end, all_day, kind }] }
// 401 wrong key · 403 sharing turned off · 503 SHARE_KEY not set · 400 bad range
// Built from what's backed up in Supabase, so it only sees changes once Irina's phone has synced.

const crypto = require('crypto');

const NAME = 'Irina', TZ = 'America/Detroit', MAX_DAYS = 120;
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
const isoDay = n => new Date(n * 864e5).toISOString().slice(0, 10);

/*SHARE-ITEMS-START*/
/* Turns Nova's tables into the shared schedule format both apps speak.
   This exact block lives in api/share.js (what Joe's Glance receives) and in index.html
   (Irina's side of the Together tab), so both always describe her day the same way.
   o = { types, shifts:[{date, shift_type_id}], events, skips:[{event_id, date}], from, to }
   from/to are 'YYYY-MM-DD', to not included. Returns [{ title, start, end, all_day, kind }] */
function shareItems(o) {
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var toU = function (s) { var p = s.split('-'); return Date.UTC(+p[0], p[1] - 1, +p[2]); };
  var fromU = function (ms) { var d = new Date(ms); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); };
  var plus = function (s, n) { return fromU(toU(s) + n * 864e5); };
  var hm = function (t) {
    var m = /^(\d{1,2}):(\d{2})/.exec(typeof t === 'string' ? t : '');
    return m && +m[1] < 24 ? pad(+m[1]) + ':' + m[2] : null;
  };
  var from = o.from, to = o.to, prev = plus(from, -1), out = [];
  var overlaps = function (start, end) { return start < to && end > from; };   // string compare works on these formats
  var types = {}, skip = {};
  (o.types || []).forEach(function (t) { types[t.id] = t; });
  (o.skips || []).forEach(function (s) { skip[s.event_id + '|' + s.date] = 1; });

  // Shifts. The day before 'from' is included so an overnight shift that ends inside the range shows up.
  (o.shifts || []).forEach(function (s) {
    var t = types[s.shift_type_id];
    if (!t || s.date < prev || s.date >= to) return;
    var st = hm(t.start_time), et = hm(t.end_time);
    if (st && et) {
      var start = s.date + 'T' + st, end = (et <= st ? plus(s.date, 1) : s.date) + 'T' + et;   // end at or before start: ends the next day
      if (overlaps(start, end)) out.push({ title: t.name, start: start, end: end, all_day: false, kind: 'work' });
    } else if (s.date >= from) {
      var mode = t.together || (/pay/i.test(t.name || '') ? 'ignore' : 'work');
      out.push({ title: t.name, start: s.date, end: plus(s.date, 1), all_day: true, kind: mode === 'ignore' ? 'note' : 'work' });
    }
  });

  // Events, with repeats expanded and skipped dates dropped.
  var occurs = function (ev, d) {
    if (d < ev.date) return false;
    if (!ev.repeat || ev.repeat === 'none') return d === ev.date;
    if (ev.repeat_until && d > ev.repeat_until) return false;
    if (skip[ev.id + '|' + d]) return false;
    var n = Math.round((toU(d) - toU(ev.date)) / 864e5);
    if (ev.repeat === 'weekly') return n % 7 === 0;
    if (ev.repeat === 'biweekly') return n % 14 === 0;
    if (ev.repeat === 'monthly') return d.slice(8) === ev.date.slice(8);
    return false;
  };
  for (var d = prev; d < to; d = plus(d, 1)) {
    (o.events || []).forEach(function (ev) {
      if (!ev.date || !occurs(ev, d)) return;
      var st = ev.all_day ? null : hm(ev.start_time);
      if (!st) {                                   // no set time: a marker, never busy
        if (d >= from) out.push({ title: ev.title, start: d, end: plus(d, 1), all_day: true, kind: 'note' });
        return;
      }
      var et = hm(ev.end_time), endDay = d;
      if (!et) {                                   // no end time: call it an hour
        var h = +st.slice(0, 2) + 1;
        if (h >= 24) { h -= 24; endDay = plus(d, 1); }
        et = pad(h) + st.slice(2);
      } else if (et <= st) endDay = plus(d, 1);
      var start = d + 'T' + st, end = endDay + 'T' + et;
      if (overlaps(start, end)) out.push({ title: ev.title, start: start, end: end, all_day: false, kind: 'plan' });
    });
  }
  return out.sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
}
/*SHARE-ITEMS-END*/

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const key = process.env.SHARE_KEY;
  if (!key) return res.status(503).json({ error: 'Sharing is not set up on this app yet' });
  if (!safeEqual(req.headers['x-share-key'] || '', key)) return res.status(401).json({ error: 'Wrong key' });

  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const from = q.from, to = q.to;
  if (!realDate(from) || !realDate(to)) return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });
  const span = dayNum(to) - dayNum(from);
  if (span < 1 || span > MAX_DAYS) return res.status(400).json({ error: `to must be 1 to ${MAX_DAYS} days after from` });

  const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!base || !secret) return res.status(500).json({ error: 'Server is missing its Supabase env vars' });
  const get = async path => {
    const r = await fetch(base + '/rest/v1/' + path, { headers: { apikey: secret, Authorization: 'Bearer ' + secret } });
    if (!r.ok) throw new Error(`GET ${path.split('?')[0]} → ${r.status} ${await r.text()}`);
    return r.json();
  };

  try {
    const settings = await get('nova_settings?select=share_on&id=eq.main');
    if (settings[0] && settings[0].share_on === false) return res.status(403).json({ error: 'Irina has sharing turned off' });

    const prev = isoDay(dayNum(from) - 1);
    const [types, shifts, events, skips, last] = await Promise.all([
      get('nova_shift_types?select=id,name,start_time,end_time,together'),
      get(`nova_shifts?select=date,shift_type_id&date=gte.${prev}&date=lt.${to}&order=date&limit=1000`),
      get(`nova_events?select=id,title,date,start_time,end_time,all_day,repeat,repeat_until&date=lt.${to}&limit=5000`),
      get(`nova_event_skips?select=event_id,date&date=gte.${prev}&date=lt.${to}&limit=5000`),
      get('nova_shifts?select=date&order=date.desc&limit=1')
    ]);
    const items = shareItems({ types, shifts, events, skips, from, to });
    return res.status(200).json({ v: 1, app: 'nova', name: NAME, tz: TZ, known_through: last[0] ? last[0].date : null, items });
  } catch (e) {
    console.error('nova share error:', e.message);
    return res.status(500).json({ error: 'Could not read the schedule' });
  }
};
