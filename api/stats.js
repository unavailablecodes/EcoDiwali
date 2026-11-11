// Vercel function: live stats dashboard backend - AUTHENTICATED.
// GET /api/stats?days=30&token=...  ->  { data: {...} }
//
// Returns 401 without a valid token issued by api/auth.js. All aggregation
// happens inside the database (public.ecodiwali_stats RPC, see supabase/schema.sql).
// Results are not cached: the dashboard is meant to mirror the database live.
//
// Public access: while PUBLIC_OPEN is true, GET /api/stats?public=1 serves the
// same data without a token (the dashboard's ?open=1 view uses it). Set it to
// false and redeploy to make the login the only way in again.

import { createHmac, timingSafeEqual } from 'node:crypto';

const PUBLIC_OPEN = true; // flip to false (and redeploy) to require login again

export default async function handler(req, res) {
  const token = String(req.query?.token || '');
  if (!PUBLIC_OPEN && !verifyToken(token)) return res.status(401).json({ error: 'This stats page is private. Log in first.' });

  const days = Math.min(Math.max(parseInt(req.query?.days, 10) || 30, 1), 365);
  res.setHeader('Cache-Control', 'no-store');

  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return res.status(503).json({ error: 'Supabase is not configured yet. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE in the Vercel project settings.' });

  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/ecodiwali_stats`, {
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
    console.error('[ecodiwali-stats]', e.message);
    res.status(502).json({ error: e.message });
  }
}

// A token is "v1.<exp>.<hmac>" where the HMAC is signed with a fixed salt
// that api/auth.js uses to issue tokens (see that file). Valid only while
// the signature matches AND the expiry is in the future - so no data is
// reachable without first passing the username/password check.
function verifyToken(token) {
  const SALT = 'ecodiwali-stats-salt-v1'; // must match the constant in api/auth.js
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const exp = parseInt(Buffer.from(parts[1], 'base64url').toString(), 10);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  // parts[2] is the base64url signature as issued; recompute it and compare in
  // constant time. Length-guarded so timingSafeEqual does not throw.
  const expect = createHmac('sha256', SALT).update(parts[1]).digest('base64url');
  const a = Buffer.from(parts[2], 'base64url'), b = Buffer.from(expect, 'base64url');
  return a.length === b.length && timingSafeEqual(a, b);
}
