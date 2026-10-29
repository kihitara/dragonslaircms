// Error responses. Phase 2 of localassets/standards-plan.md brings the rest
// (notFound, forbidden, methodNotAllowed, tooLarge, tooMany) here so no route
// keeps its own copy.

// The 500 page is self-contained: inline styles, and no D1, session or
// settings, because the thing that failed may be the database. It never says
// what went wrong; that goes to the log.
export function serverError() {
  const body = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Something went wrong</title>
<style>
  body { margin: 0; font: 1rem/1.5 system-ui, sans-serif; background: #fff; color: #1a1a1a; }
  main { max-width: 32rem; margin: 15vh auto; padding: 0 1rem; }
  h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
  a { color: #1a4f8b; }
  @media (prefers-color-scheme: dark) { body { background: #121212; color: #ececec; } a { color: #8ab4f8; } }
</style>
</head>
<body>
<main id="main">
  <h1>Something went wrong</h1>
  <p>Please try again shortly.</p>
  <p><a href="/">Go to the home page</a></p>
</main>
</body>
</html>`;
  return new Response(body, {
    status: 500,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
