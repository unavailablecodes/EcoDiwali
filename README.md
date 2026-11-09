# Ecodiwali — deployment & data setup

Diwali AR firecracker web app. Static frontend (`index.html`) + Vercel
serverless functions: `api/log.js` stores visitor analytics in Supabase,
`api/auth.js` + `api/stats.js` serve a **password-protected live dashboard** at
`/stats` (and at `stats.<your-domain>.vercel.app`).

## Files

| File | Role |
|---|---|
| `index.html` | The entire app (frontend, fireworks, camera AR, object-detection safety check) |
| `stats/index.html` | Live dashboard UI; shows a login screen first, charts render only after sign-in |
| `api/log.js` | Vercel function: receives visit/exit records, stamps IP + geo, writes to Supabase |
| `api/auth.js` | Vercel function: verifies the stats username/password, issues a 12-hour signed token |
| `api/stats.js` | Vercel function: returns live stats **only** with a valid token (401 otherwise) |
| `supabase/schema.sql` | Creates the `ecodiwali_events` table, RLS lock-down, the `ecodiwali_visitors` view, and the `ecodiwali_stats()` aggregation function |
| `vercel.json` | Rewrites any `stats.<domain>` subdomain to the dashboard |

## 1. Supabase (do once)

1. Create a project at https://supabase.com.
2. Dashboard -> **SQL Editor** -> **New query** -> paste the whole
   `supabase/schema.sql` -> **Run**.
   - Creates `public.ecodiwali_events` (raw records) and `public.ecodiwali_visitors`
     (one row per visitor, for quick stats).
   - Enables Row Level Security with **no policies** — the public `anon` key
     cannot read or write the table; only the service key can.
3. Dashboard -> **Settings -> API**:
   - Copy the **Project URL** (something like `https://abcd.supabase.co`).
   - Copy the **`service_role` key** (the *secret* one — not the `anon`/`public`
     key. The service key must never be exposed to the browser; it only lives
     in Vercel's server-side environment).

## 2. Vercel

1. Push this folder to a Git repo (or import it directly) and create a project
   on Vercel. No framework preset needed — it is plain static + a `serverless`
   function; Vercel auto-detects the `api/` directory. No build step.
2. Project -> **Settings -> Environment Variables** -> add all of these to
   Production (and to Preview if you want preview deployments writing data):

   | Variable | Value |
   |---|---|
   | `SUPABASE_URL` | the Project URL from step 1 |
   | `SUPABASE_SERVICE_ROLE` | the service_role secret key |
   | `STATS_USER` | any username of your choice (stats login) |
   | `STATS_PASS` | any password of your choice (stats login) |
   | `STATS_SECRET` | a long random string (signs the 12-hour login tokens; e.g. `openssl rand -hex 32`) |

3. Redeploy.
4. **Stats subdomain:** Project -> **Domains** -> add
   `stats.<your-project>.vercel.app` (e.g. `stats.ecodiwali.vercel.app`). The
   included `vercel.json` rewrites every request on that host to the
   dashboard (`/stats`), while `/api/*` still reaches the functions. The
   dashboard is also reachable at `https://<your-project>.vercel.app/stats`.

### How the data flows

```
index.html (visit / exit / permission events)
   │  POST  api/log   (sendBeacon, keepalive)
   ▼
api/log.js (Vercel function)
   │  stamps: ip, ipapi.co geo (best effort)
   ▼
Supabase  public.ecodiwali_events   (one row per event, kept permanently)
              │
              ├──> public.ecodiwali_visitors  (stats view, one row per visitor)
              └──> public.ecodiwali_stats()   (all dashboard numbers in one DB call)
                        ▲
                        │  live, uncached
             api/stats.js (Vercel function; password-protected)
                        ▲
                        │  12-h signed token from api/auth.js
             stats/index.html  (the dashboard, at /stats or stats.<domain>)
```

### Dashboard security

- `stats/index.html` shows a login screen; data renders only after sign-in.
- The credentials are checked in `api/auth.js` against the Vercel env vars —
  they are **never present in the page or the API code**, so nobody can read
  them from the deployed site.
- A successful sign-in issues an HMAC-SHA256 token valid for 12 hours;
  `api/stats.js` returns **401 for any request without a valid token**, so
  the API itself is private even if someone finds the URL.
- The token lives in `sessionStorage` (cleared when the tab closes).
- Data is stored permanently in Supabase regardless of whether the dashboard
  is open — queries the view/function any time.

## 3. Looking at your data

In Supabase -> SQL Editor, for example:

```sql
-- Everyone who ever visited
select * from ecodiwali_visitors order by first_seen desc limit 50;

-- Who they used, and how long
select
  count(*)                                        as total_events,
  count(distinct visitor_id)                     as unique_visitors
from ecodiwali_events;

-- Which crackers people fire most
select client->>'used' as crackers, count(*) as n
from ecodiwali_events
where event = 'x'
group by 1
order by n desc
limit 20;

-- Visits by city (from IP geo)
select geo->>'city' as city, geo->>'country' as country, count(distinct visitor_id)
from ecodiwali_events
where event = 'v'
group by 1, 2
order by 3 desc;
```

Or in the Supabase table editor: open `ecodiwali_events` (raw) or
`ecodiwali_visitors` (the rolled-up view).

## Notes & honest limitations

- **IP:** captured server-side in the function, so visitors cannot fake it.
  For city/country/ISP we reverse-lookup the IP with ipapi.co (free, no key).
  GPS coordinates are only recorded *if* the user allows the browser's
  geolocation prompt — most won't; IP geo is the reliable fallback.
- **Device model:** Android UAs include the model string; iOS UAs only say
  iPhone/iPad, so `model` is best-effort there.
- **Identity:** the persistent visitor ID lives in a first-party cookie +
  localStorage. Private/incognito browsing always mints a new ID — that is a
  hard limit of any cookie-based tracking on a static site.
- **Retention:** Supabase keeps data permanently, unlike Vercel function logs
  (~3 days on free). The function also writes every record to the Vercel log
  as a `[ecodiwali]` line, so you have a short-term backup:
  `vercel logs <your-deployment-url> | grep ecodiwali`
- **Privacy:** IP + location + time can identify individuals. Before you
  publish, add a one-line notice (e.g. "This app logs anonymous usage
  statistics for research"), and disclose it on any site where it links out.
