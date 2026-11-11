// Edge middleware for a plain (non-Next) Vercel project.
// Declared as an edge function in vercel.json, so Vercel runs it on every
// request that reaches the project before routing to static files or /api.
// Anything it does not explicitly handle passes straight through (return
// undefined), so the app, the dashboard, and the API all keep working.

export default function middleware(req) {
  const url = new URL(req.url);
  const host = (req.headers.get('host') || '').toLowerCase();

  // API routes always reach the serverless functions - never intercept.
  if (url.pathname.startsWith('/api/')) return;

  // Every old per-deployment link (e.g. ecodiwali-ab12...-unavailablecodes.
  // vercel.app, kept bookmarked or shared) still resolves on Vercel and used
  // to serve whatever build that deployment had - which is where the "login
  // screen again" reports came from. Route them all to the one clean domain.
  if (host.endsWith('-unavailablecodes.vercel.app') && host !== 'ecodiwali.vercel.app') {
    return new Response(null, {
      status: 308,
      headers: { Location: `https://ecodiwali.vercel.app${url.pathname === '/' ? '' : url.pathname}${url.search}` },
    });
  }

  // A stats.* subdomain points at the dashboard (which is served statically
  // at /stats). So: /stats passes through, and anything else on that host
  // (e.g. the bare root) redirects down to /stats. One hop, no loop.
  if (host.startsWith('stats.')) {
    if (url.pathname === '/stats') return;
    const target = new URL(req.url);
    target.pathname = '/stats';
    target.search = '';
    return new Response(null, {
      status: 308,
      headers: { Location: target.toString() },
    });
  }

  // Main host: / is the app, /stats is the dashboard - both served statically.
  return;
}
