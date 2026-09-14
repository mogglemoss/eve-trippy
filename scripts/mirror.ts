/**
 * Mirror one Tripwire's map into another — production into the dev instance.
 *
 *   npm run mirror -- pull [--out mirror/prod.json]
 *   npm run mirror -- push mirror/prod.json [--replace] [--dry-run] [--no-comments]
 *   npm run mirror -- sync [--replace] [--dry-run] [--no-comments]   (pull then push)
 *
 * Source (read-only, via the API):  MIRROR_SRC_URL / _USERNAME / _PASSWORD / _MASK,
 *   defaulting to the TRIPWIRE_* values in .env.
 * Destination (written via Tripwire's own login.php / refresh.php / comments.php):
 *   MIRROR_DST_URL / _USERNAME / _PASSWORD / _MASK. All required; there is no
 *   default destination, because writing to the wrong map is not recoverable.
 *
 * What survives the trip: systems, sig IDs, types, names, bookmarks, hole
 * type/parent/life/mass, creation and expiry times, scanner names, comments.
 * What does not: row IDs, comment authors (Tripwire stamps those from the
 * session), and anything on masks other than the one mirrored.
 *
 * --replace first removes every signature, wormhole and comment on the
 * destination mask. Without it, rows are added alongside whatever is there.
 * --no-comments leaves comments alone in both directions.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadDotEnv } from '../src/config.js';
import { TripwireClient } from '../src/tripwire/client.js';
import type { RawComment, RawSignature, RawWormhole } from '../src/tripwire/types.js';

loadDotEnv();
const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';
const flag = (f: string) => argv.includes(f);
const opt = (f: string, dflt: string) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt; };
const env = (k: string, dflt = '') => process.env[k]?.trim() || dflt;

const SRC = {
  url: env('MIRROR_SRC_URL', env('TRIPWIRE_URL')).replace(/\/+$/, ''),
  username: env('MIRROR_SRC_USERNAME', env('TRIPWIRE_USERNAME')),
  password: env('MIRROR_SRC_PASSWORD', env('TRIPWIRE_PASSWORD')),
  maskId: env('MIRROR_SRC_MASK', env('TRIPWIRE_MASK_ID')),
};
const DST = {
  url: env('MIRROR_DST_URL').replace(/\/+$/, ''),
  username: env('MIRROR_DST_USERNAME'),
  password: env('MIRROR_DST_PASSWORD'),
  maskId: env('MIRROR_DST_MASK', env('TRIPWIRE_MASK_ID')),
};
import { USER_AGENT as UA } from '../src/ua.js';
// PHP's max_input_vars defaults to 1000 form fields per request; 20 holes × 2 ends × 13 fields stays well under.
const BATCH = 20;

interface Dump {
  source: string;
  maskId: string;
  pulledAt: string;
  signatures: RawSignature[];
  wormholes: RawWormhole[];
  comments: RawComment[];
}

const rows = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : v && typeof v === 'object' ? Object.values(v as Record<string, T>) : []);

// ---------------------------------------------------------------------------

async function pull(out: string): Promise<Dump> {
  if (!SRC.username || !SRC.password) throw new Error('source login missing: set MIRROR_SRC_USERNAME/_PASSWORD or TRIPWIRE_USERNAME/_PASSWORD');
  const tw = new TripwireClient(SRC);
  console.log(`pull: ${SRC.url} mask ${SRC.maskId} as ${SRC.username}`);
  const [signatures, wormholes, comments] = await Promise.all([
    tw.raw('signatures').then(rows<RawSignature>),
    tw.raw('wormholes').then(rows<RawWormhole>),
    tw.raw('comments').then(rows<RawComment>),
  ]);
  const dump: Dump = { source: SRC.url, maskId: SRC.maskId, pulledAt: new Date().toISOString(), signatures, wormholes, comments };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(dump, null, 1));
  console.log(`  ${signatures.length} signatures, ${wormholes.length} wormholes, ${comments.length} comments → ${out}`);
  return dump;
}

// ---------------------------------------------------------------------------

class Session {
  private cookie = '';
  constructor(private readonly base: string) {}

  async login(username: string, password: string): Promise<void> {
    const res = await fetch(`${this.base}/login.php`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: new URLSearchParams({ mode: 'login', username, password }).toString(),
    });
    const set = res.headers.getSetCookie?.() ?? [];
    this.cookie = set.map((c) => c.split(';')[0]!).join('; ');
    const text = await res.text();
    if (!this.cookie || !/"result":"success"/.test(text)) throw new Error(`login to ${this.base} failed: ${text.slice(0, 160)} (Tripwire allows one login per IP per 30 s)`);
  }

  async post(path: string, form: URLSearchParams): Promise<any> {
    const res = await fetch(`${this.base}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Cookie: this.cookie },
      body: form.toString(),
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { throw new Error(`${path} answered ${res.status}: ${text.slice(0, 160)}`); }
  }
}

const SIG_FIELDS: (keyof RawSignature)[] = ['signatureID', 'systemID', 'type', 'name', 'bookmark', 'lifeTime', 'lifeLeft', 'lifeLength', 'createdByID', 'createdByName', 'modifiedByID', 'modifiedByName', 'modifiedTime'];

function sigForm(form: URLSearchParams, prefix: string, s: RawSignature): void {
  for (const k of SIG_FIELDS) {
    const v = s[k];
    if (v === null || v === undefined || v === '') continue;
    form.set(`${prefix}[${k}]`, String(v));
  }
}

async function push(dump: Dump, replace: boolean, dryRun: boolean, withComments: boolean): Promise<void> {
  if (!DST.url || !DST.username || !DST.password || !DST.maskId) throw new Error('destination missing: set MIRROR_DST_URL, MIRROR_DST_USERNAME, MIRROR_DST_PASSWORD (and MIRROR_DST_MASK or TRIPWIRE_MASK_ID)');
  console.log(`push: → ${DST.url} mask ${DST.maskId} as ${DST.username}${replace ? ' (replace)' : ''}${withComments ? '' : ' (no comments)'}${dryRun ? ' [dry run]' : ''}`);
  const sigById = new Map(dump.signatures.map((s) => [Number(s.id), s] as const));
  const paired = new Set<number>();
  const holes = dump.wormholes.filter((w) => {
    const ok = sigById.has(Number(w.initialID)) && sigById.has(Number(w.secondaryID));
    if (ok) { paired.add(Number(w.initialID)); paired.add(Number(w.secondaryID)); }
    return ok;
  });
  const singles = dump.signatures.filter((s) => !paired.has(Number(s.id)));
  const anySystem = dump.signatures.find((s) => Number(s.systemID) >= 30_000_000)?.systemID ?? 30000142;
  console.log(`  ${holes.length} wormholes (${dump.wormholes.length - holes.length} dangling skipped), ${singles.length} other signatures, ${dump.comments.length} comments`);

  let removeHoles: RawWormhole[] = [];
  let removeSigs: RawSignature[] = [];
  let removeComments: RawComment[] = [];
  if (replace) {
    const dst = new TripwireClient(DST);
    removeHoles = rows<RawWormhole>(await dst.raw('wormholes'));
    const dstSigs = rows<RawSignature>(await dst.raw('signatures'));
    const inHole = new Set(removeHoles.flatMap((w) => [Number(w.initialID), Number(w.secondaryID)]));
    removeSigs = dstSigs.filter((s) => !inHole.has(Number(s.id)));
    if (withComments) removeComments = rows<RawComment>(await dst.raw('comments'));
    console.log(`  will remove ${removeHoles.length} wormholes, ${removeSigs.length} other signatures${withComments ? ` and ${removeComments.length} comments` : ''} from the destination first`);
  }
  if (dryRun) {
    console.log('  dry run: nothing sent');
    return;
  }

  const session = new Session(DST.url);
  await session.login(DST.username, DST.password);
  const base = () => new URLSearchParams({ systemID: String(anySystem), instance: 'trippy-mirror', version: 'mirror' });
  const report = (label: string, res: any) => {
    const set: { result: boolean; value: unknown }[] = res?.resultSet ?? [];
    const bad = set.filter((r) => !r.result);
    console.log(`  ${label}: ${set.length - bad.length} ok${bad.length ? `, ${bad.length} failed (${bad.slice(0, 3).map((b) => String(b.value)).join('; ')})` : ''}`);
  };

  // Remove, in batches.
  const removals = [...removeHoles.map((w) => ({ id: String(w.id) })), ...removeSigs.map((s) => String(s.id))];
  for (let i = 0; i < removals.length; i += BATCH) {
    const form = base();
    removals.slice(i, i + BATCH).forEach((r, n) => {
      if (typeof r === 'string') form.set(`signatures[remove][${n}]`, r);
      else form.set(`signatures[remove][${n}][id]`, r.id);
    });
    report(`remove ${i + 1}-${Math.min(i + BATCH, removals.length)}`, await session.post('refresh.php', form));
  }

  // Add wormholes as pairs.
  for (let i = 0; i < holes.length; i += BATCH) {
    const form = base();
    holes.slice(i, i + BATCH).forEach((w, n) => {
      const p = `signatures[add][${n}]`;
      if (w.type) form.set(`${p}[wormhole][type]`, String(w.type));
      if (w.parent) form.set(`${p}[wormhole][parent]`, String(w.parent));
      form.set(`${p}[wormhole][life]`, String(w.life ?? 'stable'));
      form.set(`${p}[wormhole][mass]`, String(w.mass ?? 'stable'));
      sigForm(form, `${p}[signatures][0]`, sigById.get(Number(w.initialID))!);
      sigForm(form, `${p}[signatures][1]`, sigById.get(Number(w.secondaryID))!);
    });
    report(`wormholes ${i + 1}-${Math.min(i + BATCH, holes.length)}`, await session.post('refresh.php', form));
  }

  // Add the rest.
  for (let i = 0; i < singles.length; i += BATCH) {
    const form = base();
    singles.slice(i, i + BATCH).forEach((s, n) => sigForm(form, `signatures[add][${n}]`, s));
    report(`signatures ${i + 1}-${Math.min(i + BATCH, singles.length)}`, await session.post('refresh.php', form));
  }

  if (!withComments) {
    console.log('done (comments untouched)');
    return;
  }
  let gone = 0;
  for (const c of removeComments) {
    const res = await session.post('comments.php', new URLSearchParams({ mode: 'delete', commentID: String(c.id) }));
    if (res?.result) gone += 1;
  }
  if (removeComments.length) console.log(`  comments removed: ${gone}/${removeComments.length}`);

  // Comments, one call each (comments.php takes one).
  let okComments = 0;
  for (const c of dump.comments) {
    const res = await session.post('comments.php', new URLSearchParams({ mode: 'save', systemID: String(c.systemID), comment: String(c.comment ?? '') }));
    if (res?.result) okComments += 1;
  }
  console.log(`  comments: ${okComments}/${dump.comments.length} saved`);
  console.log('done');
}

// ---------------------------------------------------------------------------

const defaultOut = join('mirror', `${new URL(SRC.url || 'https://x').host.replace(/[^a-z0-9.-]/gi, '_')}.json`);
try {
  if (cmd === 'pull') {
    await pull(opt('--out', defaultOut));
  } else if (cmd === 'push') {
    const file = argv[1];
    if (!file || !existsSync(file)) throw new Error('push needs a dump file from pull');
    await push(JSON.parse(readFileSync(file, 'utf8')) as Dump, flag('--replace'), flag('--dry-run'), !flag('--no-comments'));
  } else if (cmd === 'sync') {
    const dump = await pull(opt('--out', defaultOut));
    await push(dump, flag('--replace'), flag('--dry-run'), !flag('--no-comments'));
  } else {
    console.log('usage: mirror pull [--out file] | push <file> [--replace] [--dry-run] [--no-comments] | sync [--replace] [--dry-run] [--no-comments]');
    process.exit(64);
  }
} catch (e) {
  console.error(`mirror: ${(e as Error).message}`);
  process.exit(1);
}
