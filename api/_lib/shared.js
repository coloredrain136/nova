// Shared, word for word, with index.html (and with Glance for the TG block), so the
// notification sweep sees Irina's day exactly the way the app and Glance do.
// Not a web endpoint: Vercel skips files in folders that start with an underscore.

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

/*TOGETHER-CORE-START*/
/* Together (core v2): when are both people free? Pure functions, no screen code.
   Glance and Nova use this exact block, so both apps always agree.
   Times are local (both phones are in the same time zone).

   Item: {s, e (ms), allDay, kind:'work'|'plan'|'note', title, who:'me'|'them'}
     Anything already on a calendar is fixed: work and plan both block their time.
     note = a marker (payday), never busy. work also triggers the night-shift sleep rule.
   TG.plan({items, from, days, now, through:{me,them}, opt:{h0,h1,minH,sleep}})
     h0/h1   hang hours (9 and 23 = 9am to 11pm)
     minH    shortest time that counts as a hang, in hours
     sleep   after an overnight shift ends in the morning, busy until this hour (0 = off)
     through last date ('YYYY-MM-DD') each person's schedule is filled in, or null
   Each day comes back as one of:
     full    nothing on either calendar during hang hours ("day off together")
     free    a stretch of at least minH with nothing in the way
     none    nothing long enough
   (v2: "maybe" days are gone. counts.maybe stays 0 and D.skip/D.plans stay empty so older screens still work.)
     unknown past someone's filled-in schedule */
var TG = (function () {
  var MIN = 6e4, HOUR = 36e5;
  function sod(ms) { var d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
  function next(ms) { var d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(); }
  function at(day, h) { var d = new Date(day); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(h), Math.round((h % 1) * 60)).getTime(); }
  function key(ms) { var d = new Date(ms); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function parse(s) { // "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM", local wall time
    var m = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d))?/.exec(s || '');
    return m ? new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)).getTime() : NaN;
  }
  // Items from the other app's /api/share answer
  function fromShare(list, who) {
    var out = [];
    (list || []).forEach(function (x) {
      var s = parse(x.start), e = parse(x.end);
      if (isNaN(s)) return;
      if (isNaN(e) || e < s) e = s;
      var k = x.kind === 'work' || x.kind === 'note' ? x.kind : 'plan';
      out.push({ s: s, e: e, allDay: !!x.all_day, kind: k, title: String(x.title || ''), who: who });
    });
    return out;
  }
  // [a,b] minus a list of [s,e] blocks
  function minus(a, b, blocks) {
    var segs = a < b ? [[a, b]] : [];
    blocks.forEach(function (k) {
      var out = [];
      segs.forEach(function (g) {
        if (k[1] <= g[0] || k[0] >= g[1]) { out.push(g); return; }
        if (k[0] > g[0]) out.push([g[0], k[0]]);
        if (k[1] < g[1]) out.push([k[1], g[1]]);
      });
      segs = out;
    });
    return segs;
  }
  function longest(segs) { var b = null; segs.forEach(function (g) { if (!b || g[1] - g[0] > b[1] - b[0]) b = g; }); return b; }
  function partOfDay(a, b) {
    var h = new Date(a).getHours();
    if (b - a >= 7 * HOUR) return h < 12 ? 'Most of the day' : 'Afternoon & evening';
    return h < 12 ? 'Morning' : h < 16 ? 'Afternoon' : 'Evening';
  }

  function plan(o) {
    var opt = o.opt || {}, h0 = opt.h0 == null ? 9 : opt.h0, h1 = opt.h1 == null ? 23 : opt.h1;
    var minMs = (opt.minH || 3) * HOUR, sleep = opt.sleep == null ? 14 : opt.sleep;
    var now = o.now || Date.now(), thr = o.through || {};
    var items = (o.items || []).filter(function (x) { return x.kind !== 'note'; });
    var days = [], day = sod(o.from || now), counts = { full: 0, free: 0, maybe: 0 }, first = null, unknown = null;

    for (var i = 0; i < (o.days || 28); i++, day = next(day)) {
      var k = key(day), dEnd = next(day);
      var W0 = at(day, h0), W1 = h1 >= 24 ? dEnd : at(day, h1), full0 = W0, full1 = W1;
      if (now > W0) W0 = Math.ceil(now / (15 * MIN)) * 15 * MIN; // today: only what's left
      var D = { key: k, day: day, win: [W0, W1], kind: 'none', segs: [], skip: [], plans: [], busy: { me: [], them: [] } };
      days.push(D);
      var lateMe = thr.me && k > thr.me, lateThem = thr.them && k > thr.them;
      if (lateMe || lateThem) {
        D.kind = 'unknown'; D.who = lateMe && lateThem ? 'both' : lateMe ? 'me' : 'them';
        if (!unknown) unknown = { key: k, who: D.who };
        continue;
      }
      if (W1 - W0 < minMs) continue;

      var busy = [];
      items.forEach(function (x) {
        var s = x.allDay ? sod(x.s) : x.s, e = x.allDay ? sod(x.e) : x.e;
        if (e > day && s < dEnd) {
          busy.push([Math.max(s, day), Math.min(e, dEnd)]);
          if (e > full0 && s < full1) D.busy[x.who].push({ a: Math.max(s, full0), b: Math.min(e, full1), kind: x.kind, title: x.title });
        }
        // An overnight work shift that ended this morning: asleep until the sleep hour
        if (sleep && x.kind === 'work' && !x.allDay && s < day && e > day && e - s >= 6 * HOUR && new Date(e).getHours() < 12) {
          var wake = at(day, sleep);
          if (wake > e) {
            busy.push([e, wake]);
            if (wake > full0) D.busy[x.who].push({ a: Math.max(e, full0), b: Math.min(wake, full1), kind: 'sleep', title: 'Sleeping after ' + x.title });
          }
        }
      });

      var open = minus(W0, W1, busy).filter(function (g) { return g[1] - g[0] >= minMs; });
      if (!open.length) continue;
      if (full1 - full0 >= 8 * HOUR && W0 === full0 && open.length === 1 && open[0][0] === W0 && open[0][1] === W1) {
        D.kind = 'full'; D.segs = [[W0, W1]];
      } else {
        D.kind = 'free'; D.segs = open;
      }
      var best = D.kind === 'full' ? D.segs[0] : longest(D.segs);
      D.a = best[0]; D.b = best[1]; D.len = best[1] - best[0];
      D.label = D.kind === 'full' ? 'Day off together' : partOfDay(D.a, D.b);
      counts[D.kind]++;
      if (!first && (D.kind === 'full' || D.kind === 'free')) first = D;
    }
    return { days: days, counts: counts, next: first, unknown: unknown };
  }

  return { plan: plan, fromShare: fromShare, parse: parse, key: key, minus: minus };
})();
/*TOGETHER-CORE-END*/

module.exports = { shareItems, TG };
