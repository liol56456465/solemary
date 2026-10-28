// dbTarget.js — shared safety rules for the backup / restore / drill scripts.
// - The target host is read the way pg and libpq read it (a ?host= parameter overrides the
//   address, so such parameters are stripped first).
// - Writing to a database that is not on this machine needs --confirm-host=<that host>, so a
//   copied command or a fallback to POSTGRES_URL cannot wipe the live database by accident.
// - The password goes to pg_dump / pg_restore / psql through PGPASSWORD, not the command line
//   (anyone on the machine can read command lines with ps).
// - Dumps are created readable by the owner only (they hold sessions, appeals and tokens).

import { chmod } from 'node:fs/promises';
import { parse } from 'pg-connection-string';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);
const TARGET_PARAMS = ['host', 'hostaddr', 'port', 'user', 'password', 'dbname', 'database', 'service', 'passfile'];

/** The URL without parameters that would override its address. */
export function withoutTargetOverrides(url) {
  const parsed = new URL(url);
  for (const name of TARGET_PARAMS) parsed.searchParams.delete(name);
  return parsed.toString();
}

export function hostOf(url) {
  return String(parse(withoutTargetOverrides(url)).host || '').toLowerCase();
}

export function isLocalUrl(url) {
  return LOCAL_HOSTS.has(hostOf(url));
}

/** Throws unless the target is local or the operator typed its host in --confirm-host. */
export function assertWriteTargetAllowed(url, confirmHost, action) {
  const host = hostOf(url);
  if (LOCAL_HOSTS.has(host)) return;
  if (typeof confirmHost === 'string' && confirmHost.toLowerCase() === host) return;
  throw new Error(`${action} would write to the remote database host "${host}". If that is really intended, re-run with --confirm-host=${host}.`);
}

/** { url, env } for a pg_* / psql child process: the password moves from the URL to PGPASSWORD. */
export function libpqTarget(url) {
  const parsed = new URL(withoutTargetOverrides(url));
  const password = decodeURIComponent(parsed.password || '');
  parsed.password = '';
  const env = { ...process.env };
  if (password) env.PGPASSWORD = password;
  return { url: parsed.toString(), env };
}

/** Owner-only files from here on (dump files, backup folders). */
export function ownerOnlyFiles() {
  process.umask(0o077);
}

export async function makeOwnerOnly(file) {
  await chmod(file, 0o600);
}
