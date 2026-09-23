# DragonslairCMS

A self-contained CMS on Cloudflare Workers: one Worker serves the public site and the admin, rendering everything at runtime from D1 — publishing is an instant database flip, no build pipeline. Point it at your own Cloudflare account and deploy in minutes.

## Stack

| Piece | Choice |
|---|---|
| Compute | Cloudflare Workers, plain JavaScript ES modules, no build step |
| Database | D1 — hand-written SQL, no ORM |
| Media | R2, served by the Worker at `/media/<key>` |
| Email | Cloudflare Workers `send_email` binding (optional; needs Workers Paid + a verified sender) |
| Styling | CSS custom properties generated at runtime (`/theme.css`) from design tokens in D1 |

## Features

- **Pages** — block-based (20+ block types incl. a media gallery), draft → publish with frozen snapshots, revision history, per-block surface palettes, live preview.
- **Articles** — WYSIWYG body with inline **image galleries** (grid or carousel + lightbox), custom **categories**, ordered **series/trips** (an article can join several), authors/reviewers, tags, covers, **scheduled publishing**, and the same snapshot/revision model with live preview.
- **Discovery** — flat `/posts/:slug` permalinks, `/category/:slug` and `/series/:slug` listings, an **RSS feed** (`/feed.xml`), `sitemap.xml`, `robots.txt`, and a public **search** page. Responsive images are downscaled to WebP on upload. The site root can be a **static home page or a blog-style article feed** (with a Browse sidebar) — a one-setting toggle.
- **Publish control** — draft / published / modified states, revert, and **unpublish (take offline)** that returns a live item to draft without deleting it.
- **Branding** — design tokens (light + dark), surface palette designer, font uploads, logo/favicon, navigation/footer editors, and global settings (site title, canonical URL, email sender, SEO). The whole site re-themes from the admin — no code edits.
- **Community** — moderated comments (anonymous or reader accounts) with staff replies, corrections on articles *and* pages, blog subscription emails.
- **Readers** — front-end-only role: self-registration (admin-toggleable) with email verification + approval, dashboard, subscriptions, notification prefs.
- **Users** — admin / publisher / editor roles, activity log, login rate limiting.

## Requirements

- A **Cloudflare account**. **The Workers Free plan is enough** to run the whole CMS (Workers, D1 and R2 are all on Free). The *only* feature that needs **Workers Paid** + a domain is **outgoing email** — and that's optional: the CMS runs in "no-email mode" without it (see [Email & no-email mode](#email--no-email-mode)).
- For the CLI paths: **Node 20+** (Node 22 recommended — see `.nvmrc`).

---

## Install

Two easy paths — pick one. Both leave you with your own Worker, D1 database and R2 bucket, and neither needs you to hand-edit resource IDs. The site title, canonical URL and email sender are configured in the admin afterwards, not in config files.

### Option A — Deploy to Cloudflare (one click, in the browser)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kihitara/dragonslaircms)

This clones the repo into **your** GitHub/GitLab account, **auto-provisions** the D1 database and R2 bucket, deploys, and wires up push-to-deploy CI. There is nothing to fill in and no secrets to generate — the Worker mints its own session-signing secrets on first run. When it finishes, jump to [First run](#first-run).

### Option B — Guided CLI setup

```sh
git clone https://github.com/kihitara/dragonslaircms.git
cd dragonslaircms
npm install
npx wrangler login        # authorises this machine with your Cloudflare account
npm run setup             # interactive: names, resources, secrets, schema, deploy
```

`npm run setup` asks what to call the Worker, the D1 database and the R2 bucket (Enter accepts the defaults), then creates the resources, writes `wrangler.jsonc`, applies `schema.sql`, and deploys. It asks for no secrets. Add `--dry-run` to see every step without changing anything, or `--no-deploy` to stop before the deploy. Then head to [First run](#first-run).

---

## First run

Open your Worker's URL and go to **`/admin`** — with an empty database it redirects to **`/admin/setup`**, a one-time screen (shown only while there are no users) where you create the first admin account in the browser. Do this right after deploying, before sharing the URL.

Then, in **Admin → Settings**, set:

- **Organisation name** and **tagline** — shown in the header, footer and titles.
- **Site URL (canonical)** — your deployed origin (`https://<worker>.<subdomain>.workers.dev` or a custom domain). Used for canonical tags, the RSS feed, the sitemap and email links.
- **Email “From” address** — only if you're using email (see below).
- **Home page** — serve a static `home` page (default) or a blog-style **article feed** at the site root. For a pure blog, choose the feed and you never need a `home` page.
- Logo/favicon, colours, fonts, navigation, footer, pages, articles, email copy — all editable in the admin.

Everything above lives in the database, so you rarely touch `wrangler.jsonc` again. Deploy code updates with `npm run deploy`, which applies `schema.sql` (idempotent — safe to re-run) before deploying, so a schema change never needs a separate step. (With Option A, pushing to your repo's main branch deploys.)

> **CLI alternative to `/admin/setup`:** seed the first admin from the terminal:
> ```sh
> node scripts/seed-admin.js <email> "<name>" <password> > /tmp/seed.sql
> npm run db:schema:remote   # if you haven't applied the schema yet
> wrangler d1 execute DB --file=/tmp/seed.sql --remote
> ```

---

## Local development

```sh
npm install
npm run db:schema                 # create the local D1 schema
npm run dev                       # wrangler dev (local)
```

Open the local URL and go to `/admin` → `/admin/setup` to create the first admin, then log in. Nothing else to configure: the local database gets its own generated session secrets, separate from your deployed site's.

## Manual / advanced setup

You don't need this if you used Option A or B. It's here for full control or CI.

- **Resources:** since Wrangler 4.45, `npm run deploy` auto-provisions any D1/R2 in `wrangler.jsonc` that don't exist yet and writes their IDs back. To create them yourself instead: `wrangler d1 create <name>` (paste the id into `d1_databases[0].database_id`) and `wrangler r2 bucket create <name>`.
- **Secrets:** none are required. The Worker generates `ADMIN_SESSION_SECRET` / `READER_SESSION_SECRET` on first run and stores them in the database. To pin or rotate them yourself, `wrangler secret put ADMIN_SESSION_SECRET` (32+ random chars) — a secret that is set always wins over the generated one, and setting one signs everybody out.
- **Schema + deploy:** `npm run deploy` applies `schema.sql` to the remote database and then deploys. `npm run db:schema:remote` (remote) and `npm run db:schema` (local) apply the schema on their own.
- **CLI credentials for CI:** instead of `wrangler login`, copy `.env.example` to `.env` and set `CLOUDFLARE_API_TOKEN` (dashboard → My Profile → API Tokens → “Edit Cloudflare Workers” template, **plus a `D1 → Edit`** permission) and `CLOUDFLARE_ACCOUNT_ID` (dashboard → Workers & Pages → right sidebar, or `npx wrangler whoami`). `.env` is gitignored — never commit it.

### Using your own names

`npm run setup` handles this for you. If you're doing it by hand, the starter uses `dragonslaircms` for the Worker, the D1 database and the R2 bucket — rename any or all, keeping each name consistent:

- **Worker name** — `wrangler.jsonc` → top-level `"name"`.
- **D1 database name** — `wrangler.jsonc` → `d1_databases[0].database_name`. One place only: the `db:schema*` scripts address the `DB` **binding**, not the database name.
- **R2 bucket name** — `wrangler.jsonc` → `r2_buckets[0].bucket_name`.

Leave the **binding** names (`DB`, `MEDIA`, `EMAIL`, `ASSETS`) as they are — the code refers to those, not the resource names.

## Email & no-email mode

Outgoing email uses the Cloudflare `send_email` binding (`EMAIL` in `wrangler.jsonc`), which needs the **Workers Paid** plan and a domain set up for **Email Routing**.

**To enable email:**

1. Keep the `send_email` block in `wrangler.jsonc`.
2. In the Cloudflare dashboard, add your domain and enable **Email Routing**.
3. Under **Email → Email Routing → Settings → Custom Addresses**, add and verify the address you'll send from.
4. In **Admin → Settings**, set the **Email “From” address** to that verified address and leave **“Send outgoing email”** on.

**No-email mode (Workers Free plan / no domain):** turn off **“Send outgoing email”** in **Admin → Settings** (and optionally remove the `send_email` block from `wrangler.jsonc`). The CMS detects this and adapts so nothing is left half-working:

- **Admin notifications** (new comment / correction / registration) → shown in-app via the sidebar badges and dashboard instead of emailed.
- **Reader self-registration** → skips email verification; new accounts land in the **Admin → Readers** approval queue (or are usable immediately if approval is off).
- **Password resets** → the email-based “Forgot password?” links are hidden. Admins reset each other from **Admin → Users**; a reader is reset from **Admin → Readers → Set password**.
- **Reader convenience emails** (comment-reply / new-article) → simply not sent.

Either way, nothing crashes if a send fails — email errors are logged and swallowed. All email copy is editable under **Admin → Email templates**.

## Optional: emoticons

The editor's emoticon picker starts empty. Sample dragon emoticons live in `assets/emoticons/`; upload your own (or these) via **Admin → Emoticons**.

## Layout

```
schema.sql              D1 schema (apply with db:schema*; migrations noted in-file)
scripts/setup.js        Guided one-command deploy (npm run setup)
scripts/seed-admin.js   CLI first-admin seeder (alternative to /admin/setup)
src/index.js            Worker entry — route pipeline, /theme.css, env resolver
src/routes/admin.js     Admin auth gate, first-run setup, section dispatcher
src/routes/admin-*.js   One module per admin section
src/routes/public-*.js  Public renderers (pages, articles, people)
src/routes/discovery.js RSS feed, sitemap.xml, robots.txt
src/routes/search.js    Public search
src/routes/reader.js    Reader account flows (/reader/*)
src/routes/api.js       Form/JSON endpoints (/api/*)
src/tokens.js           Design token defaults + CSS generators
src/templates/          HTML shells and the runtime block renderer
public/                 Static assets (CSS, editor JS, icons)
```

## License

MIT — see [LICENSE](LICENSE).
