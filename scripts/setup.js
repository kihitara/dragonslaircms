#!/usr/bin/env node
/**
 * DragonslairCMS guided setup — one command to stand up a fresh deployment.
 *
 *   npm run setup            # interactive: create resources, deploy
 *   npm run setup -- --dry-run   # print every action, change nothing
 *   npm run setup -- --no-deploy # do everything except the final deploy
 *
 * It asks what to call the Worker, the D1 database and the R2 bucket, then:
 *   1. creates the D1 database and R2 bucket (via wrangler),
 *   2. writes those names + the new database_id into wrangler.jsonc,
 *   3. applies schema.sql to the remote database,
 *   4. deploys the Worker.
 *
 * It asks for no secrets: the Worker mints its own session-signing secrets on
 * first run and keeps them in the database.
 *
 * Prerequisites: Node 20+, a Cloudflare account, and `wrangler login` (the
 * script offers to run it). Uses only Node built-ins — no extra dependencies.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv } from 'node:process';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = argv.includes('--dry-run');
const NO_DEPLOY = argv.includes('--no-deploy');

const rl = createInterface({ input: stdin, output: stdout });
const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' };
const say = (s = '') => console.log(s);
const step = (s) => say(`\n${c.bold}${c.cyan}▸ ${s}${c.reset}`);
const ok = (s) => say(`${c.green}✓${c.reset} ${s}`);
const warn = (s) => say(`${c.yellow}!${c.reset} ${s}`);
const fail = (s) => { say(`${c.red}✗ ${s}${c.reset}`); rl.close(); process.exit(1); };

// Run a command. Returns { code, stdout }. In dry-run, prints and no-ops.
function sh(cmd, args, { capture = false, input } = {}) {
  const pretty = `${cmd} ${args.join(' ')}`;
  if (DRY) { say(`${c.dim}[dry-run] ${pretty}${c.reset}`); return { code: 0, stdout: '' }; }
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    stdio: capture ? ['pipe', 'pipe', 'inherit'] : (input != null ? ['pipe', 'inherit', 'inherit'] : 'inherit'),
    shell: process.platform === 'win32', // npx.cmd on Windows
  });
  return { code: res.status ?? 1, stdout: res.stdout || '' };
}
const wrangler = (args, opts) => sh('npx', ['wrangler', ...args], opts);

const cleanName = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 54);

async function ask(question, def) {
  const suffix = def ? ` ${c.dim}(${def})${c.reset}` : '';
  const a = (await rl.question(`${question}${suffix}: `)).trim();
  return a || def || '';
}
async function confirm(question, def = true) {
  const a = (await rl.question(`${question} ${c.dim}(${def ? 'Y/n' : 'y/N'})${c.reset} `)).trim().toLowerCase();
  if (!a) return def;
  return a === 'y' || a === 'yes';
}

async function main() {
  say(`${c.bold}DragonslairCMS setup${c.reset}`);
  say(`${c.dim}This creates Cloudflare resources on your account and deploys the CMS.${c.reset}`);
  if (DRY) warn('Dry run — no resources will be created and nothing will be written.');

  // 1. wrangler present + authenticated
  step('Checking wrangler and your Cloudflare login');
  const ver = wrangler(['--version'], { capture: true });
  if (ver.code !== 0 && !DRY) fail('wrangler is not available. Run `npm install` first.');
  const who = wrangler(['whoami'], { capture: true });
  const loggedIn = DRY || /account/i.test(who.stdout);
  if (!loggedIn) {
    if (await confirm('You are not logged in to Cloudflare. Run `wrangler login` now?')) {
      const r = wrangler(['login']);
      if (r.code !== 0) fail('Login failed. Run `npx wrangler login` and try again.');
    } else {
      fail('Cloudflare login is required. Run `npx wrangler login` and re-run setup.');
    }
  } else ok('Cloudflare login found.');

  // 2. names
  step('Naming your resources');
  say(`${c.dim}Lowercase letters, numbers and hyphens only. Enter to accept the default.${c.reset}`);
  const workerName = cleanName(await ask('Worker name', 'dragonslaircms')) || 'dragonslaircms';
  const dbName = cleanName(await ask('D1 database name', workerName)) || workerName;
  const bucketName = cleanName(await ask('R2 bucket name', workerName)) || workerName;
  say(`\nWorker: ${c.bold}${workerName}${c.reset}   D1: ${c.bold}${dbName}${c.reset}   R2: ${c.bold}${bucketName}${c.reset}`);
  if (!await confirm('Create these and continue?')) fail('Cancelled.');

  // 3. create D1 + read its id
  step(`Creating D1 database "${dbName}"`);
  const d1 = wrangler(['d1', 'create', dbName], { capture: true });
  if (d1.code !== 0 && !/already exists/i.test(d1.stdout)) {
    say(d1.stdout);
    fail('Could not create the D1 database.');
  }
  let databaseId = 'REPLACE_WITH_DATABASE_ID';
  if (!DRY) {
    const list = wrangler(['d1', 'list', '--json'], { capture: true });
    try {
      const row = JSON.parse(list.stdout || '[]').find((d) => d.name === dbName);
      if (row && (row.uuid || row.database_id)) databaseId = row.uuid || row.database_id;
    } catch { /* fall through */ }
    if (databaseId === 'REPLACE_WITH_DATABASE_ID') fail(`Created the database but could not read its id. Run \`npx wrangler d1 list\`, copy the id for "${dbName}" into wrangler.jsonc, and re-run with --no-deploy skipped as needed.`);
    ok(`database_id: ${databaseId}`);
  }

  // 4. create R2 bucket
  step(`Creating R2 bucket "${bucketName}"`);
  const r2 = wrangler(['r2', 'bucket', 'create', bucketName], { capture: true });
  if (r2.code !== 0 && !/already exists/i.test(r2.stdout)) { say(r2.stdout); fail('Could not create the R2 bucket.'); }
  ok('R2 bucket ready.');

  // 5. patch wrangler.jsonc (the db:schema scripts address the DB *binding*, so
  // they need no patching whatever the database is called)
  step('Writing configuration');
  patchWrangler({ workerName, dbName, bucketName, databaseId });
  ok('wrangler.jsonc updated.');

  // 6. remote schema
  step('Applying the database schema (remote)');
  const mig = wrangler(['d1', 'execute', dbName, '--file=schema.sql', '--remote', '--yes'], {});
  if (mig.code !== 0) warn('Schema step returned a non-zero code — check the output above. You can re-run `npm run db:schema:remote`.');
  else ok('Schema applied.');

  // 7. deploy
  if (NO_DEPLOY) {
    warn('Skipping deploy (--no-deploy). Run `npm run deploy` when ready.');
  } else if (await confirm('Deploy the Worker now?')) {
    step('Deploying');
    const dep = wrangler(['deploy'], {});
    if (dep.code !== 0) fail('Deploy failed — see the output above.');
    ok('Deployed.');
  } else {
    warn('Skipped deploy. Run `npm run deploy` when ready.');
  }

  say(`\n${c.green}${c.bold}Setup complete.${c.reset}`);
  say('Next steps:');
  say(`  1. Open your Worker's URL and go to ${c.bold}/admin/setup${c.reset} to create the first admin account.`);
  say(`  2. In ${c.bold}Admin → Settings${c.reset}, set the site title, canonical URL and (if using email) the From address.`);
  say(`  3. On the Workers Free plan or with no email domain, turn ${c.bold}"Send outgoing email" OFF${c.reset} in Settings.`);
  rl.close();
}

function patchWrangler({ workerName, dbName, bucketName, databaseId }) {
  if (DRY) { say(`${c.dim}[dry-run] patch wrangler.jsonc → name=${workerName}, db=${dbName} (${databaseId}), bucket=${bucketName}${c.reset}`); return; }
  const p = join(ROOT, 'wrangler.jsonc');
  let t = readFileSync(p, 'utf8');
  t = t.replace(/("name"\s*:\s*")[^"]*(")/, `$1${workerName}$2`);
  t = t.replace(/("database_name"\s*:\s*")[^"]*(")/, `$1${dbName}$2`);
  // Replace an existing database_id, or insert one right after database_name
  // (the committed template omits it so the Deploy button can auto-provision).
  if (/"database_id"\s*:/.test(t)) {
    t = t.replace(/("database_id"\s*:\s*")[^"]*(")/, `$1${databaseId}$2`);
  } else {
    t = t.replace(/("database_name"\s*:\s*"[^"]*")/, `$1,\n\t\t\t"database_id": "${databaseId}"`);
  }
  t = t.replace(/("bucket_name"\s*:\s*")[^"]*(")/, `$1${bucketName}$2`);
  writeFileSync(p, t);
}

main().catch((e) => fail(e?.stack || String(e)));
