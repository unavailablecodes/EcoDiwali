-- =============================================================================
-- Ecodiwali visitor analytics  (Supabase)
-- Run this ONCE in your Supabase project: Dashboard -> SQL Editor -> New query
-- -> paste everything below -> Run. It is safe to re-run.
--
-- The Vercel function api/log.js inserts one row per client event into
-- public.ecodiwali_events using the service_role key, which is NOT exposed to the
-- browser. The table has Row Level Security on with no policies, so the public
-- "anon" key can neither read nor write it - only your server can.
-- =============================================================================

-- One row per client event (visit start 'v', exit 'x', ...). `client` holds the
-- full browser payload as-is; the columns on the left are promoted for querying.
create table if not exists public.ecodiwali_events (
  id          bigint generated always as identity primary key,
  visitor_id  text not null,            -- persistent id (cookie + localStorage)
  event       text not null,           -- 'v' = visit start, 'x' = exit
  visit_no    int,                      -- which visit this is for the browser
  first_ts    timestamptz,             -- when this visitor was first seen
  ip          text,                    -- visitor public IP, stamped server-side
  geo         jsonb,                   -- {city,state,country,org,lat,lng} from IP
  client      jsonb,                   -- entire browser payload, verbatim
  app_ts      timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists ecodiwali_events_visitor_idx
  on public.ecodiwali_events (visitor_id, app_ts);
create index if not exists ecodiwali_events_event_idx
  on public.ecodiwali_events (event);

-- Lock it down: enable RLS and define no policies. With RLS on and zero policies,
-- the anon key gets 0 rows; the service_role key (used only by the server) bypasses RLS.
alter table public.ecodiwali_events enable row level security;


-- =============================================================================
-- Convenience view: one row per visitor, for quick research without hand-writing
-- GROUP BY. timeMs in the client payload is cumulative, so the largest 'x' in a
-- visit is that visit's total time on the app.
-- =============================================================================
create or replace view public.ecodiwali_visitors as
select
  e.visitor_id,
  min(e.app_ts)  as first_seen,
  max(e.app_ts)  as last_seen,
  count(*) filter (where e.event = 'v')                as visit_count,
  -- total time on the app, in milliseconds = sum over days of each day's largest
  -- exit timeMs (timeMs is cumulative within a visit, so the biggest one is the total)
  (
    select coalesce(sum(max_time), 0)
    from (
      select max((ev.client->>'timeMs')::bigint) as max_time
      from public.ecodiwali_events ev
      where ev.visitor_id = e.visitor_id and ev.event = 'x'
      group by date_trunc('day', ev.app_ts)
    ) per_day
  ) as total_time_ms,
  (array_agg(e.ip order by e.app_ts desc) filter (where e.ip is not null))[1]          as last_ip,
  (array_agg(e.geo order by e.app_ts desc) filter (where e.geo is not null))[1]         as last_geo,
  (array_agg(e.client->>'model'  order by e.app_ts desc) filter (where e.client->>'model'  is not null))[1] as device_model,
  (array_agg(e.client->>'os'     order by e.app_ts desc) filter (where e.client->>'os'     is not null))[1] as os,
  (array_agg(e.client->>'browser' order by e.app_ts desc) filter (where e.client->>'browser' is not null))[1] as browser
from public.ecodiwali_events e
group by e.visitor_id;


-- =============================================================================
-- ecodiwali_stats(days): one call returns everything the dashboard needs.
-- Call it from api/stats.js via PostgREST RPC:
--   POST {SUPABASE_URL}/rest/v1/rpc/ecodiwali_stats   body: {"days": 30}
-- All aggregation happens in the database, so the Vercel function stays thin
-- no matter how much data you collect.
-- =============================================================================
create or replace function public.ecodiwali_stats(days int default 30)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
select jsonb_build_object(
  'window_days', days,
  'generated_at', now(),

  'kpis', (
    select jsonb_build_object(
      'unique_visitors', count(distinct visitor_id) filter (where event = 'v'),
      'total_events', count(*),
      'today_visits', count(*) filter (where event = 'v' and app_ts >= date_trunc('day', now())),
      'avg_time_s', coalesce(round(avg(
        (client->>'timeMs')::numeric
        filter (where event = 'x' and coalesce((client->>'timeMs')::numeric, 0) > 0)
      ) / 1000)::int, 0)
    ) from public.ecodiwali_events
    where app_ts >= now() - make_interval(days => days)
  ),

  'per_day', (
    select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'visitors', d.visitors, 'events', d.events) order by d.day), '[]'::jsonb)
    from (
      select g.day::date as day,
             (select count(*) from public.ecodiwali_events e
               where e.event = 'v' and e.app_ts >= g.day and e.app_ts < g.day + interval '1 day'
                 and e.app_ts >= now() - make_interval(days => days)) as visitors,
             (select count(*) from public.ecodiwali_events e
               where e.app_ts >= g.day and e.app_ts < g.day + interval '1 day'
                 and e.app_ts >= now() - make_interval(days => days)) as events
      from generate_series((date_trunc('day', now())::date - (days - 1)), date_trunc('day', now())::date, interval '1 day') as g(day)
    ) d
  ),

  'top_crackers', (
    select coalesce(jsonb_agg(o order by n desc), '[]'::jsonb)
    from (
      select jsonb_build_object('name', e2.k, 'n', sum((e2.v)::int)) as o, sum((e2.v)::int) as n
      from public.ecodiwali_events e,
           lateral jsonb_each(coalesce(e.client->'used', '{}'::jsonb)) e2(k, v)
      where e.event = 'x' and e.app_ts >= now() - make_interval(days => days)
      group by e2.k
      limit 12
    ) s
  ),

  'os_split', (
    select coalesce(jsonb_agg(o order by n desc), '[]'::jsonb)
    from (
      select jsonb_build_object('os', t.os, 'n', t.n) as o, t.n
      from (
        select coalesce(nullif(client->>'os', ''), 'unknown') as os, count(*) as n
        from public.ecodiwali_events
        where event = 'v' and app_ts >= now() - make_interval(days => days)
        group by 1
        order by 2 desc
        limit 8
      ) t
    ) s
  ),

  'countries', (
    select coalesce(jsonb_agg(o order by n desc), '[]'::jsonb)
    from (
      select jsonb_build_object('country', coalesce(t.c, 'unknown'), 'n', t.n) as o, t.n
      from (
        select geo->>'country' as c, count(*) as n
        from public.ecodiwali_events
        where event = 'v' and geo is not null and app_ts >= now() - make_interval(days => days)
        group by 1
        order by 2 desc
        limit 10
      ) t
    ) s
  ),

  'recent', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', visitor_id, 'first_seen', first_seen, 'last_seen', last_seen,
      'visits', visit_count, 'total_time_ms', total_time_ms,
      'ip', last_ip, 'city', last_geo->>'city', 'country', last_geo->>'country',
      'model', device_model, 'os', os, 'browser', browser)
      order by last_seen desc), '[]'::jsonb)
    from public.ecodiwali_visitors
    limit 15
  )
);
$$;

revoke execute on function public.ecodiwali_stats(int) from public, anon, authenticated;
grant execute on function public.ecodiwali_stats(int) to service_role;
