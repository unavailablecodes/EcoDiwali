// Edge middleware: makes any "stats." subdomain of the project's Vercel domain
// serve the dashboard (stats/index.html), while /api/* requests on that host
// still reach the serverless functions. On the main host, /stats does the same.
//
// So:  https://ecodiwiki.vercel.app/stats  and  https://stats.ecodiwiki.vercel.app
// both open the login-gated live dashboard; everything else on the main host
// (the fireworks app at /, /api/log, ...) is untouched.

import { NextResponse } from 'next/server';

export function middleware(req) {
  // API requests always pass through to the functions, on every host.
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;

  const host = (req.headers.get('host') || '').toLowerCase();
  const isStatsHost = host.startsWith('stats.');
  // Main host: only the /stats path maps to the dashboard.
  if (!isStatsHost && url.pathname !== '/stats') return;

  const target = new URL(req.url);
  target.pathname = '/stats';
  return NextResponse.rewrite(target);
}

// Run for every non-API path; cheap early returns for everything else.
export const config = {
  matcher: ['/((?!api/).*)'],
};
