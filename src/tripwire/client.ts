/**
 * Read-only client for Tripwire's HTTP API.
 *
 * Tripwire exposes `GET /api.php?q=/<resource>&maskID=<mask>` behind HTTP Basic
 * auth using a Tripwire *account* login. Resources: signatures, wormholes,
 * comments, statistics. The same path works on upstream (Apache) and on the
 * refit (nginx rewrites /api/<resource> to it), so we always use the explicit
 * form.
 *
 * Quirks handled here, learned from api/auth.php and public/api.php:
 *   - 401 for a bad login, 503 when TRIPWIRE_API is off in config.php.
 *   - A mask problem is reported as *text* ("Mask ID is required", "You are not
 *     authorized to use this mask") echoed in front of a JSON `null`, HTTP 200.
 *   - An empty result is the literal `null`, not `[]`.
 *   - Dates are `Y-m-d H:i:s e`, e.g. "2026-09-07 12:00:00 UTC".
 */
import type {
  Comment, Life, Mass, ParentSide, RawComment, RawSignature, RawWormhole, SigType, Signature, Snapshot, Wormhole,
} from './types.js';
import { USER_AGENT } from '../ua.js';

export type TripwireErrorKind = 'auth' | 'disabled' | 'mask' | 'http' | 'parse' | 'network';

export class TripwireError extends Error {
  constructor(public readonly kind: TripwireErrorKind, message: string) {
    super(message);
    this.name = 'TripwireError';
  }
}

export interface TripwireClientOptions {
  url: string;
  username: string;
  password: string;
  maskId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

export type Resource = 'signatures' | 'wormholes' | 'comments' | 'statistics';

export class TripwireClient {
  readonly url: string;
  readonly maskId: string;
  private readonly auth: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(o: TripwireClientOptions) {
    this.url = o.url.replace(/\/+$/, '');
    this.maskId = o.maskId;
    this.auth = 'Basic ' + Buffer.from(`${o.username}:${o.password}`).toString('base64');
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 20_000;
    this.userAgent = o.userAgent ?? USER_AGENT;
  }

  endpoint(resource: Resource, params: Record<string, string> = {}): URL {
    const u = new URL(`${this.url}/api.php`);
    u.searchParams.set('q', `/${resource}`);
    u.searchParams.set('maskID', this.maskId);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u;
  }

  async raw(resource: Resource, params: Record<string, string> = {}): Promise<unknown> {
    const url = this.endpoint(resource, params);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { Authorization: this.auth, Accept: 'application/json', 'User-Agent': this.userAgent },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new TripwireError('network', `Tripwire unreachable at ${this.url}: ${(e as Error).message}`);
    }
    return parseApiBody(res.status, await res.text());
  }

  async signatures(systemId?: number): Promise<Signature[]> {
    const rows = asRows<RawSignature>(await this.raw('signatures', systemId ? { systemID: String(systemId) } : {}));
    return rows.map(normaliseSignature);
  }

  async wormholes(): Promise<Wormhole[]> {
    return asRows<RawWormhole>(await this.raw('wormholes')).map(normaliseWormhole);
  }

  async comments(systemId?: number): Promise<Comment[]> {
    const rows = asRows<RawComment>(await this.raw('comments', systemId ? { systemID: String(systemId) } : {}));
    return rows.map(normaliseComment);
  }

  async snapshot(): Promise<Snapshot> {
    const [signatures, wormholes] = await Promise.all([this.signatures(), this.wormholes()]);
    return { signatures, wormholes, fetchedAt: new Date() };
  }
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

const MASK_MESSAGES = ['Mask ID is required', 'You are not authorized to use this mask', 'MaskID must be a decimal'];

export function parseApiBody(status: number, text: string): unknown {
  if (status === 401) throw new TripwireError('auth', 'Tripwire rejected the username/password (401).');
  if (status === 503) throw new TripwireError('disabled', 'The Tripwire API is switched off on this server (TRIPWIRE_API in config.php).');
  const body = text.trim();
  if (status === 400) throw new TripwireError('mask', body || 'Tripwire answered 400 Bad Request.');
  if (status !== 200) throw new TripwireError('http', `Tripwire answered HTTP ${status}.`);
  const maskMessage = MASK_MESSAGES.find((m) => body.startsWith(m));
  if (maskMessage) throw new TripwireError('mask', `${maskMessage} — check TRIPWIRE_MASK_ID and that this account can see that mask.`);
  if (body === '' || body === 'null') return [];
  if (body.startsWith('[') || body.startsWith('{')) {
    try {
      return JSON.parse(body);
    } catch {
      throw new TripwireError('parse', 'Tripwire returned malformed JSON.');
    }
  }
  throw new TripwireError('parse', `Unexpected Tripwire response: ${body.slice(0, 120)}`);
}

function asRows<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') return Object.values(value as Record<string, T>);
  return [];
}

// ---------------------------------------------------------------------------
// Dates: "Y-m-d H:i:s e" where e is a tz identifier ("UTC", "Europe/London")
// ---------------------------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\s+(.+))?$/;

export function parseTripwireDate(input: string): Date {
  const m = DATE_RE.exec(input.trim());
  if (!m) {
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) throw new TripwireError('parse', `Unparseable date "${input}"`);
    return d;
  }
  const [, y, mo, d, h, mi, s, tz] = m;
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const zone = tz ?? 'UTC';
  if (zone === 'UTC' || zone === 'Z' || zone === 'GMT') return new Date(asUtc);
  return new Date(asUtc - zoneOffsetMs(zone, asUtc));
}

/** Offset of `zone` from UTC at roughly the given instant, in ms. */
function zoneOffsetMs(zone: string, utcMs: number): number {
  const fixed = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
  if (fixed) {
    const sign = fixed[1] === '-' ? -1 : 1;
    return sign * (Number(fixed[2]) * 60 + Number(fixed[3])) * 60_000;
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
    const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return local - utcMs;
  } catch {
    return 0; // unknown zone name: treat as UTC rather than fail the whole poll
  }
}

// ---------------------------------------------------------------------------
// Row normalisation
// ---------------------------------------------------------------------------

const toInt = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const toText = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
};

function safeDate(v: unknown, fallback: Date): Date {
  if (typeof v !== 'string') return fallback;
  try {
    return parseTripwireDate(v);
  } catch {
    return fallback;
  }
}

const SIG_TYPES: ReadonlySet<string> = new Set<SigType>(['unknown', 'combat', 'data', 'relic', 'ore', 'gas', 'wormhole']);

export function normaliseSignature(raw: RawSignature): Signature {
  const id = toInt(raw.id);
  if (id === null) throw new TripwireError('parse', 'Signature row without an id');
  const rawSig = toText(raw.signatureID);
  const sigId = rawSig && rawSig !== '???' ? rawSig.replace('-', '').toUpperCase() : null;
  const now = new Date();
  const createdAt = safeDate(raw.lifeTime, now);
  const type = SIG_TYPES.has(raw.type) ? (raw.type as SigType) : 'unknown';
  return {
    id,
    sigId,
    systemId: toInt(raw.systemID),
    type,
    name: toText(raw.name),
    bookmark: toText(raw.bookmark),
    createdAt,
    expiresAt: safeDate(raw.lifeLeft, createdAt),
    lifeLengthSec: toInt(raw.lifeLength) ?? 0,
    createdBy: toText(raw.createdByName) ?? '',
    modifiedBy: toText(raw.modifiedByName) ?? '',
    modifiedAt: safeDate(raw.modifiedTime, createdAt),
  };
}

export function normaliseWormhole(raw: RawWormhole): Wormhole {
  const id = toInt(raw.id);
  const initialId = toInt(raw.initialID);
  const secondaryId = toInt(raw.secondaryID);
  if (id === null || initialId === null || secondaryId === null) {
    throw new TripwireError('parse', 'Wormhole row missing id/initialID/secondaryID');
  }
  const parentRaw = toText(raw.parent)?.toLowerCase();
  const parent: ParentSide | null = parentRaw === 'initial' || parentRaw === 'secondary' ? parentRaw : null;
  const life: Life = raw.life === 'critical' ? 'critical' : 'stable';
  const mass: Mass = raw.mass === 'critical' ? 'critical' : raw.mass === 'destab' ? 'destab' : 'stable';
  return { id, initialId, secondaryId, type: toText(raw.type)?.toUpperCase() ?? null, parent, life, mass };
}

export function normaliseComment(raw: RawComment): Comment {
  const id = toInt(raw.id);
  const systemId = toInt(raw.systemID);
  if (id === null || systemId === null) throw new TripwireError('parse', 'Comment row missing id/systemID');
  const now = new Date();
  const createdAt = safeDate(raw.created, now);
  return {
    id,
    systemId,
    text: typeof raw.comment === 'string' ? raw.comment : '',
    createdAt,
    createdBy: toText(raw.createdByName) ?? '',
    modifiedAt: safeDate(raw.modified, createdAt),
    modifiedBy: toText(raw.modifiedByName) ?? '',
  };
}
