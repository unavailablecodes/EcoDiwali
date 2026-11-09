// Vercel function: live stats dashboard backend - AUTHENTICATED.
// GET /api/stats?days=30&token=...  ->  { data: {...} }
//
// Returns 401 without a valid token issued by api/auth.js. All aggregation
// happens inside the database (public.ecodiwiki_stats RPC, see supabase/schema.sql).
// Results are not cached: the dashboard is meant to mirror the database live.

import { createHmac } from 'node:crypto';

export default async function handler(req, res) {
  const token = String(req.query?.token || '');
  if (!verifyToken(token)) return res.status(401).json({ error: 'This stats page is private. Log in first.' });

  const days = Math.min(Math.max(parseInt(req.query?.days, 10) || 30, 1), 365);
  res.setHeader('Cache-Control', 'no-store');

  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return res.status(503).json({ error: 'Supabase is not configured yet. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE in the Vercel project settings.' });

  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/ecodiwiki_stats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({ days }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`Supabase responded with ${r.status}`);
    const data = await r.json();
    res.status(200).json({ data, source: 'supabase', days });
  } catch (e) {
    console.error('[ecodiwiki-stats]', e.message);
    res.status(502).json({ error: e.message });
  }
}

// A token is "exp.base64url(expiryMs).base64url(hmac(expiryMs))" (see api/auth.js).
// It is valid only if the signature matches AND it has not expired AND the secret
// is configured - so there is no way to read this endpoint without the password.
function verifyToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3 || !process.env.STATS_SECRET) return false;
  const exp = parseInt(Buffer.from(parts[1], 'base64url').toString(), 10);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const expect = createHmac('sha256', process.env.STATS_SECRET).update(parts[1]).digest('base64url');
  const a = Buffer.from(parts[2], 'base64url').toString(), b = expect;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
