// Vercel serverless function: receives visitor analytics from index.html and
// stores one row per record in Supabase (public.ecodiwali_events).
//
// Setup, one time:
//   1. Run supabase/schema.sql in your Supabase project (SQL Editor -> Run).
//   2. Project Settings -> API: copy the "Project URL" and the
//      "service_role" secret key.
//   3. Vercel dashboard -> your project -> Settings -> Environment
//      Variables -> add:
//        SUPABASE_URL           (e.g. https://xyzcompany.supabase.co)
//        SUPABASE_SERVICE_ROLE  (the secret service_role key, NOT the anon key)
//   4. Redeploy.
//
// Why service_role and not anon: the table has Row Level Security enabled with
// no policies, so the anon key gets 0 access. service_role bypasses RLS and
// stays server-side, never shipped to the browser.
//
// Records are batched one insert per request (each request is already a single
// JSON line). If Supabase is unreachable, the record is also written to the
// Vercel function log as [ecodiwali] so nothing is silently lost.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  let body;
  try { body = req.body; } catch (e) { return res.status(400).json({ ok: false, why: 'bad-body' }); }
  if (!body || typeof body !== 'object' || !body.e || !body.s) return res.status(400).json({ ok: false, why: 'bad-shape' });
  if (JSON.stringify(body).length > 8192) return res.status(400).json({ ok: false, why: 'too-big' });

  const ip = (req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.socket?.remoteAddress || '').split(',')[0].trim() || 'unknown';

  // City-level location from the IP. Free, no key; fails soft. Primary source
  // is ipinfo.io (reliable) with ipapi.co as a fallback if it ever hiccups.
  let geo = null;
  for (const src of [
    (ip) => `https://ipinfo.io/${encodeURIComponent(ip)}/json`,
    (ip) => `https://ipapi.co/json/${encodeURIComponent(ip)}`,
  ]) {
    try {
      const r = await fetch(src(ip), { signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const g = await r.json();
        if (g && g.city && g.country) {
          geo = {
            city: g.city,
            state: g.region || g.region_code || null,
            country: g.country_name || g.country || null,
            org: g.org || null,
            lat: g.latitude ?? null,
            lng: g.longitude ?? null,
          };
          break;
        }
      }
    } catch (e) { /* try the next source */ }
  }

  const row = {
    visitor_id: body.s,
    event: body.e,
    visit_no: body.visitNo ?? null,
    first_ts: body.firstTs ? new Date(body.firstTs).toISOString() : null,
    ip,
    geo,
    client: body,
  };

  const saved = await saveToSupabase(row);

  // Always keep a copy in the function log too - cheap insurance and handy for
  // debugging: `vercel logs <url> | grep ecodiwali`.
  console.log('[ecodiwali] ' + JSON.stringify({ ...row, app_ts: new Date().toISOString() }));
  res.status(202).json({ ok: true, saved });
}

async function saveToSupabase(row) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return false; // not configured yet: log-only mode

  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/rest/v1/ecodiwali_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Prefer': 'return=minimal, missing=ignore',
      },
      body: JSON.stringify([row]),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      console.error('[ecodiwali] supabase insert failed:', r.status, (await r.text()).slice(0, 300));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[ecodiwali] supabase insert error:', e.message);
    return false;
  }
}
