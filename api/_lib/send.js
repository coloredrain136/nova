// Sends a web push to every subscribed phone and forgets phones that have gone away.
const webpush = require('web-push');

function ready() {
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://nova.vercel.app', pub, priv);
  return true;
}
async function sendAll(db, subs, msg) {
  let sent = 0, gone = 0, failed = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(msg), { TTL: 3600, urgency: 'high', topic: (msg.tag || 'nova').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'nova' });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        gone++;
        try { await db.del(`nova_push_subs?endpoint=eq.${encodeURIComponent(s.endpoint)}`); } catch (x) {}
      } else { failed++; console.error('nova push failed:', e.statusCode, e.body || e.message); }
    }
  }
  return { sent, gone, failed };
}
module.exports = { ready, sendAll };
