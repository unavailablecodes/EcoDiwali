// Edge middleware for a PLAIN (non-Next) Vercel project: uses only the
// standard Web API, because `next/server` is not available here.
//
// Makes any "stats." subdomain of the project's host serve the dashboard,
// and maps /stats on the main host to it too. /api/* always passes through
// to the serverless functions, on every host.

export function middleware(req) {
  const url = new URL(req.url);
  // API requests always reach the functions.
  if (url.pathname.startsWith('/api/')) return;

  const host = (req.headers.get('host') || '').toLowerCase();
  const isStatsHost = host.startsWith('stats.');
  // On the main host, only the /stats path maps to the dashboard.
  if (!isStatsHost && url.pathname !== '/stats') return;

  // Returning a new Request = Vercel rewrite to the dashboard page.
  const target = new URL(req.url);
  target.pathname = '/stats';
  target.search = '';
  return new Request(target, req);
}

export const config = {
  matcher: ['/((?!api/).*)'],
};
