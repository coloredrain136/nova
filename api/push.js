// Nova push notifications: this iPhone subscribes here, and Settings sends its test from here.
// POST { action } with header x-nova-passcode (the backup passcode).
//   key          → { publicKey }
//   subscribe    { sub: PushSubscription JSON } → { ok }
//   unsubscribe  { endpoint } → { ok }
//   status       { endpoint } → { subscribed, phones }
//   test         → sends "Notifications are working" to every subscribed phone
// Env vars: SUPABASE_URL, SUPABASE_SECRET_KEY, NOVA_PASSCODE, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT

const crypto = require('crypto');
const { supa } = require('./_lib/supa');
const { ready, sendAll } = require('./_lib/send');

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const pass = process.env.NOVA_PASSCODE;
  if (!pass) return res.status(500).json({ error: 'Server is missing NOVA_PASSCODE' });
  if (!safeEqual(req.headers['x-nova-passcode'] || '', pass)) return res.status(401).json({ error: 'Wrong passcode' });

  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Bad JSON' }); } }
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return res.status(503).json({ error: 'not_setup' });
  const db = supa();
  if (!db) return res.status(500).json({ error: 'Server is missing its Supabase env vars' });

  try {
    switch (body.action) {
      case 'key':
        return res.status(200).json({ publicKey: process.env.VAPID_PUBLIC_KEY });
      case 'subscribe': {
        const s = body.sub || {}, k = s.keys || {};
        if (typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || !k.p256dh || !k.auth) return res.status(400).json({ error: 'Bad subscription' });
        await db.upsert('nova_push_subs', [{ endpoint: s.endpoint, p256dh: String(k.p256dh), auth: String(k.auth), device: String(req.headers['user-agent'] || '').slice(0, 200) }], 'endpoint');
        return res.status(200).json({ ok: true });
      }
      case 'unsubscribe':
        if (typeof body.endpoint === 'string') await db.del(`nova_push_subs?endpoint=eq.${encodeURIComponent(body.endpoint)}`);
        return res.status(200).json({ ok: true });
      case 'status': {
        const subs = await db.get('nova_push_subs?select=endpoint');
        return res.status(200).json({ subscribed: subs.some(s => s.endpoint === body.endpoint), phones: subs.length });
      }
      case 'test': {
        ready();
        const subs = await db.get('nova_push_subs?select=endpoint,p256dh,auth');
        const r = await sendAll(db, subs, { title: 'Nova', body: 'Notifications are working.', tag: 'test', url: '/' });
        return res.status(200).json({ ok: true, ...r });
      }
      default:
        return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (e) {
    console.error('nova push error:', e.message);
    return res.status(500).json({ error: 'Push failed' });
  }
};
