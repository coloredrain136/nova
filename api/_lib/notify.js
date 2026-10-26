// Which notifications are due right now? Pure function, no network, so it can be tested exactly.
// Runs with process.env.TZ set to Irina's time zone, so plain Date math is local time.
//
// Per-item overrides ("remind" column on events and shift types), all text:
//   null      use the default from Settings → Notifications
//   'none'    never remind
//   '<n>'     n minutes before it starts (timed things)        e.g. '60', '1440' (a day before)
//   'morning' the morning of, at the day-notes time (things with no set time)
//   'eve'     the night before, at the night-before time (things with no set time)

const NOTIFY_DEF = {
  shiftEve: true, eveTime: '20:00',            // "Tomorrow: AM 12hr" the night before
  shiftBefore: 'none',                          // minutes before a shift starts
  eventBefore: '60',                            // minutes before a timed plan
  notes: true, notesTime: '08:00',              // day notes (no set time) the morning of
  daily: false, dailyTime: '06:30',             // the day's rundown
  weekly: false, weeklyDay: 0, weeklyTime: '18:00',   // the week ahead
  together: false, togetherTime: '10:00',       // "You and Joe are both free today"
  quiet: true, quietFrom: '22:00', quietTo: '06:00'   // holds before-reminders that would land overnight
};
const LOOKBACK = 30 * 60e3;   // the sweep runs every 5 minutes; anything due in the last 30 that wasn't sent yet goes out

const pad = n => String(n).padStart(2, '0');
const ds = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const pd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = pd(s); d.setDate(d.getDate() + n); return ds(d); };
const dayDiff = (a, b) => Math.round((Date.UTC(...b.split('-').map((v, i) => i === 1 ? v - 1 : +v)) - Date.UTC(...a.split('-').map((v, i) => i === 1 ? v - 1 : +v))) / 864e5);
const hmOk = t => typeof t === 'string' && /^\d{1,2}:\d{2}/.test(t);
const at = (date, hm) => { const [y, m, d] = date.split('-').map(Number), [h, mi] = hm.split(':').map(Number); return new Date(y, m - 1, d, h, mi).getTime(); };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtTime(t, h24) {
  const [h, m] = t.split(':').map(Number);
  if (h24) return pad(h) + ':' + pad(m);
  return (h % 12 || 12) + ':' + pad(m) + ' ' + (h >= 12 ? 'PM' : 'AM');
}
function fmtRange(a, b, h24) {
  if (!b) return fmtTime(a, h24);
  if (h24) return fmtTime(a, true) + ' – ' + fmtTime(b, true);
  const pa = +a.split(':')[0] >= 12, pb = +b.split(':')[0] >= 12, same = pa === pb && b > a;
  const short = same ? fmtTime(a, false).replace(/ [AP]M$/, '') : fmtTime(a, false);
  return short + ' – ' + fmtTime(b, false);
}
function lenText(min) {
  if (min >= 1440 && min % 1440 === 0) return min === 1440 ? 'tomorrow' : `in ${min / 1440} days`;
  if (min >= 60) { const h = Math.floor(min / 60), r = min % 60; return 'in ' + (r ? `${h}h ${r}m` : h === 1 ? '1 hour' : `${h} hours`); }
  return min ? `in ${min} min` : 'now';
}

function occurs(ev, d, skip) {
  if (!ev.date || d < ev.date) return false;
  if (!ev.repeat || ev.repeat === 'none') return d === ev.date;
  if (ev.repeat_until && d > ev.repeat_until) return false;
  if (skip.has(ev.id + '|' + d)) return false;
  const n = dayDiff(ev.date, d);
  if (ev.repeat === 'weekly') return n % 7 === 0;
  if (ev.repeat === 'biweekly') return n % 14 === 0;
  if (ev.repeat === 'monthly') return d.slice(8) === ev.date.slice(8);
  return false;
}
const timed = ev => !ev.all_day && hmOk(ev.start_time);

// "Quiet hours" only hold the automatic before-reminders. Anything she set a time for comes at that time.
function inQuiet(ms, n) {
  if (!n.quiet) return false;
  const d = new Date(ms), hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  return n.quietFrom <= n.quietTo ? hm >= n.quietFrom && hm < n.quietTo : hm >= n.quietFrom || hm < n.quietTo;
}
function quietEnd(ms, n) {
  const d = new Date(ms), today = ds(d);
  let end = at(today, n.quietTo);
  if (end <= ms) end = at(addDays(today, 1), n.quietTo);
  return end;
}

/* o = { now, prefs, types, shifts:[{date, shift_type_id}], events, skips, sent:Set(keys) }
   → [{ key, fire, title, body }] plus { key, fire, together:true, date } for the Together heads-up */
function dueNow(o) {
  const n = { ...NOTIFY_DEF, ...((o.prefs && o.prefs.notify) || {}) };
  const h24 = !!(o.prefs && o.prefs.appearance && o.prefs.appearance.time24);
  const now = o.now, today = ds(new Date(now)), out = [];
  const types = new Map((o.types || []).map(t => [t.id, t]));
  const shifts = new Map((o.shifts || []).map(s => [s.date, s.shift_type_id]));
  const skip = new Set((o.skips || []).map(s => s.event_id + '|' + s.date));
  const sent = o.sent || new Set();
  const push = (key, fire, title, body, extra) => {
    if (fire > now || fire <= now - LOOKBACK || sent.has(key)) return;
    out.push({ key, fire, title, body, ...(extra || {}) });
  };
  const evsOn = d => (o.events || []).filter(e => occurs(e, d, skip))
    .sort((a, b) => (timed(a) ? a.start_time : '') < (timed(b) ? b.start_time : '') ? -1 : 1);
  const shiftOn = d => { const t = types.get(shifts.get(d)); return t || null; };
  const shiftText = t => (hmOk(t.start_time) && hmOk(t.end_time) ? fmtRange(t.start_time, t.end_time, h24) + (t.end_time <= t.start_time ? ' (ends next day)' : '') : 'No set time');
  const held = (fire, start) => {            // before-reminders: hold through quiet hours, drop if it already started
    if (!inQuiet(fire, n)) return fire;
    const e = quietEnd(fire, n);
    return e < start ? e : null;
  };

  // A reminder can fire up to a day before its item, so look at today through two days out.
  for (let i = -1; i <= 2; i++) {
    const d = addDays(today, i);

    // Shifts
    const t = shiftOn(d);
    if (t && t.remind !== 'none') {
      if (n.shiftEve) push(`se|${d}|${n.eveTime}`, at(addDays(d, -1), n.eveTime), `Tomorrow: ${t.name}`, shiftText(t));
      if (hmOk(t.start_time)) {
        const r = t.remind != null && t.remind !== '' ? t.remind : n.shiftBefore;
        const min = parseInt(r, 10);
        if (r !== 'none' && min >= 0) {
          const start = at(d, t.start_time), fire = held(start - min * 60e3, start);
          if (fire != null) push(`sb|${d}|${t.start_time}|${min}`, fire, `${t.name} at ${fmtTime(t.start_time, h24)}`, `Starts ${lenText(Math.round((start - fire) / 60e3))}`);
        }
      }
    }

    // Plans and day notes
    for (const ev of evsOn(d)) {
      if (timed(ev)) {
        const r = ev.remind != null && ev.remind !== '' ? ev.remind : n.eventBefore;
        const min = parseInt(r, 10);
        if (r === 'none' || !(min >= 0)) continue;
        const start = at(d, ev.start_time), fire = held(start - min * 60e3, start);
        if (fire == null) continue;
        const left = Math.round((start - fire) / 60e3);
        const when = new Date(fire).getDate() === new Date(start).getDate() ? 'Today' : 'Tomorrow';
        push(`eb|${ev.id}|${d}|${ev.start_time}|${min}`, fire, ev.title,
          `${when} at ${fmtTime(ev.start_time, h24)}${left > 0 && left < 1440 ? ` (${lenText(left)})` : ''}`);
      } else {
        const r = ev.remind != null && ev.remind !== '' ? ev.remind : (n.notes ? 'morning' : 'none');
        if (r === 'morning') push(`en|${ev.id}|${d}|m|${n.notesTime}`, at(d, n.notesTime), `Today: ${ev.title}`, 'On your calendar today');
        else if (r === 'eve') push(`en|${ev.id}|${d}|e|${n.eveTime}`, at(addDays(d, -1), n.eveTime), `Tomorrow: ${ev.title}`, 'On your calendar tomorrow');
      }
    }

    // The day's rundown
    if (n.daily) {
      const parts = [], s = shiftOn(d), evs = evsOn(d);
      if (s) parts.push(`${s.name} ${shiftText(s)}`);
      const plans = evs.map(e => timed(e) ? `${e.title} at ${fmtTime(e.start_time, h24)}` : e.title);
      let body = parts.join('');
      if (plans.length) body += (body ? '. Then ' : '') + plans.join(', ');
      if (!body) body = 'Day off, nothing planned.';
      else if (!s) body = 'Day off. ' + body;
      push(`dy|${d}|${n.dailyTime}`, at(d, n.dailyTime), 'Today', body.endsWith('.') ? body : body + '.');
    }

    // The week ahead, on the chosen day
    if (n.weekly && pd(d).getDay() === +n.weeklyDay) {
      const days = [];
      let plans = 0;
      for (let k = 1; k <= 7; k++) {
        const dd = addDays(d, k), s = shiftOn(dd);
        if (s && !(s.together === 'ignore' || (!s.together && /pay/i.test(s.name) && !hmOk(s.start_time)))) days.push(DOW[pd(dd).getDay()]);
        plans += evsOn(dd).filter(timed).length;
      }
      const a = days.length ? `${days.length} ${days.length === 1 ? 'shift' : 'shifts'}: ${days.join(', ')}` : 'No shifts';
      const b = plans ? `${plans} ${plans === 1 ? 'plan' : 'plans'}` : 'nothing else planned';
      push(`wk|${d}|${n.weeklyTime}`, at(d, n.weeklyTime), 'The week ahead', `${a}. ${b[0].toUpperCase() + b.slice(1)}.`);
    }

    // Together heads-up (the sweep fills in the text after asking Glance)
    if (n.together) push(`tg|${d}|${n.togetherTime}`, at(d, n.togetherTime), '', '', { together: true, date: d });
  }
  return out;
}

module.exports = { dueNow, NOTIFY_DEF, fmtTime, fmtRange, lenText, inQuiet, quietEnd };
