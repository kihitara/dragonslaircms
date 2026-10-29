// Security headers for every response the Worker makes, errors and redirects
// included. Static files get the same headers from public/_headers, because
// Workers Assets answers those before this code runs.
//
// The Content-Security-Policy is not here yet: it needs every inline script
// moved out or nonced first, and it ships report-only for one release before it
// is enforced (localassets/standards-plan.md, Phase 3). A response that already
// sets one of these headers keeps its own value, which is how /media/ files
// carry their stricter sandboxing policy.

const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

// The PDF export prints a page by loading it in a hidden iframe on the same
// site (public/js/export-print.js), so those routes may be framed by this site
// and no other.
const PRINT_ROUTE = /^\/admin\/(pages|articles)\/\d+\/print$/;

export function withSecurityHeaders(response, url) {
  const res = new Response(response.body, response); // headers on fetched responses are immutable
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!res.headers.has(name)) res.headers.set(name, value);
  }
  if (PRINT_ROUTE.test(url.pathname)) res.headers.set('X-Frame-Options', 'SAMEORIGIN');
  return res;
}

// Every request that can change something has to come from a page on this
// site. SameSite=Lax cookies are not enough on their own: every app on the same
// registrable domain counts as the same site, so Lax would let a page in a
// sibling app post here. A missing Origin is allowed, because browsers send one
// on every cross-site POST; a request without one did not come from another
// site's page. `null`, an unparseable value or another host is refused.
export function crossSiteRequest(request, url) {
  if (request.method === 'GET' || request.method === 'HEAD') return false;
  const origin = request.headers.get('Origin');
  if (origin === null) return false;
  try {
    return new URL(origin).host !== url.host;
  } catch {
    return true; // includes the literal string "null"
  }
}
