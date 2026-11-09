// Vercel function: login for the stats dashboard.
// GET  /api/stats -> 401 without a token from here
//
// Credentials and the signing secret live ONLY in Vercel environment
// variables (server-side, never shipped to the browser):
//   STATS_USER   your username
//   STATS_PASS   your password
//   STATS_SECRET any random string (signs the tokens; keep it long and unique)
//
// The token is HMAC-SHA256 signed, carries its own expiry (12 h), and is
// validated by api/stats.js, so a visitor who finds the page can see
// nothing without the password - and with a stolen token, nothing after 12 h.

import { createHmac } from 'node:crypto';

export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const user = process.env.STATS_USER, pass = process.env.STATS_PASS;
  if (!user || !pass) {
    return res.status(503).json({ error: 'Stats login is not configured yet. Add STATS_USER, STATS_PASS and STATS_SECRET to the Vercel project environment variables, then redeploy.' });
  }
  const b = req.body || {};
  if (b.user === user && b.pass === pass) {
    const exp = Date.now() + 12 * 3600 * 1000; // 12 h
    res.status(200).json({ token: sign(exp), exp });
  } else {
    res.status(401).json({ error: 'Wrong username or password.' });
  }
}

function sign(expMs) {
  const body = Buffer.from(String(expMs)).toString('base64url');
  const sig = createHmac('sha256', process.env.STATS_SECRET).update(body).digest('base64url');
  return 'v1.' + body + '.' + sig;
}
