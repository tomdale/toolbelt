import { parseEnv } from 'node:util';
import { readFile, writeFile, lstat } from 'node:fs/promises';

const [originText, envFile, cookieFile] = process.argv.slice(2);
const origin = new URL(originText);
if (origin.protocol !== 'https:' || origin.origin !== originText) throw Error('Expected exact HTTPS origin');
const info = await lstat(envFile);
if (!info.isFile() || info.mode & 0o077 || info.uid !== process.getuid()) throw Error('Password file must be an owned private regular file');
const password = parseEnv(await readFile(envFile, 'utf8')).BB_GATEWAY_OWNER_PASSWORD;
if (!password || [...password].length < 12) throw Error('Temporary password needs at least 12 characters');
const response = await fetch(`${origin.origin}/_gateway/login`, { method: 'POST', headers: { origin: origin.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }), redirect: 'manual', signal: AbortSignal.timeout(30000) });
if (response.status !== 303) throw Error(`Owner login failed: ${response.status}`);
const cookie = response.headers.getSetCookie().find(value => value.startsWith('__Host-bb-owner='))?.split(';')[0];
if (!cookie) throw Error('No owner session received');
await writeFile(cookieFile, `${cookie}\n`, { mode: 0o600, flag: 'wx' });
console.log('Owner session saved privately; no credential output');
