// Tiny Supabase REST helper for the server functions. Uses the secret key from env vars.
function supa() {
  const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!base || !key) return null;
  const headers = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  const call = async (path, opts = {}) => {
    const r = await fetch(base + '/rest/v1/' + path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path.split('?')[0]} → ${r.status} ${await r.text()}`);
    return r;
  };
  return {
    get: async path => (await call(path)).json(),
    upsert: (table, rows, onConflict) => call(`${table}?on_conflict=${onConflict}`, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) }),
    insertIgnore: (table, rows, onConflict) => call(`${table}?on_conflict=${onConflict}`, { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify(rows) }).then(r => r.json()),
    del: path => call(path, { method: 'DELETE' })
  };
}
module.exports = { supa };
