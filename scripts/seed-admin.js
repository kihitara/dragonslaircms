#!/usr/bin/env node
// Generate SQL to seed (or reset) a CMS admin user, matching src/auth.js hashing.
//
//   node scripts/seed-admin.js <email> <name> <password> > /tmp/seed.sql
//   wrangler d1 execute dragonslaircms --file=/tmp/seed.sql [--remote]

import { webcrypto as crypto } from 'node:crypto';

async function hashPassword(password) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, keyMaterial, 256
  );
  const hex = (arr) => Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex(salt) + ':' + hex(new Uint8Array(bits));
}

async function main() {
  const [email, name, password] = process.argv.slice(2);
  if (!email || !name || !password) {
    console.error('Usage: node scripts/seed-admin.js <email> <name> <password>');
    process.exit(1);
  }
  const hash = await hashPassword(password);
  const esc = (s) => s.replaceAll("'", "''");
  console.log(
    `INSERT INTO users (email, name, role, password_hash) VALUES ('${esc(email.toLowerCase())}', '${esc(name)}', 'admin', '${hash}')\n` +
    `ON CONFLICT(email) DO UPDATE SET password_hash = '${hash}', active = 1;`
  );
}

main();
