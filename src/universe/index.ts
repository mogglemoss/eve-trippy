/**
 * Static knowledge of New Eden: every solar system with its class, security and
 * region (plus effect and statics for W-space), and every wormhole type's mass
 * and lifetime. Built once by `npm run universe` into data/universe.json and
 * loaded from disk at start, so the bot never needs the SDE or the network for
 * a name lookup.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type ClassKey =
  | 'hs' | 'ls' | 'ns' | 'pochven'
  | 'c1' | 'c2' | 'c3' | 'c4' | 'c5' | 'c6' | 'c13' | 'thera'
  | 'sentinel' | 'barbican' | 'vidette' | 'conflux' | 'redoubt'
  | 'unknown';

export interface SystemInfo {
  id: number;
  name: string;
  cls: ClassKey;
  /** True security for k-space; null for W-space. */
  sec: number | null;
  region: string;
  effect: string | null;
  statics: string[];
  shattered: boolean;
}

export interface HoleType {
  code: string;
  dest: ClassKey | null;
  src: ClassKey[];
  isStatic: boolean;
  totalMass: number | null;
  jumpMass: number | null;
  lifetimeHours: number | null;
  massRegen: number | null;
}

export interface Universe {
  systems: Map<number, SystemInfo>;
  /** Lower-cased name → system. */
  byName: Map<string, SystemInfo>;
  holes: Map<string, HoleType>;
  classes: Map<string, string>;
  /** Stargate adjacency (k-space only), both directions. */
  gates: Map<number, number[]>;
  generatedAt: string;
}

/** Row layout inside data/universe.json (kept compact: ~8,400 rows). */
export type SystemRow = [
  id: number, name: string, cls: string, sec: number | null, region: string,
  effect: string | null, statics: string[], shattered: 0 | 1,
];

export interface UniverseFile {
  version: number;
  generatedAt: string;
  classes: Record<string, string>;
  holes: Record<string, Omit<HoleType, 'code'>>;
  systems: SystemRow[];
  /** Undirected stargate pairs [from, to], each once. */
  gates?: [number, number][];
}

export const DEFAULT_UNIVERSE_PATH = fileURLToPath(new URL('../../data/universe.json', import.meta.url));

const CLASS_KEYS: ReadonlySet<string> = new Set<ClassKey>([
  'hs', 'ls', 'ns', 'pochven', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c13', 'thera',
  'sentinel', 'barbican', 'vidette', 'conflux', 'redoubt', 'unknown',
]);

export function asClassKey(value: string | null | undefined): ClassKey {
  return value && CLASS_KEYS.has(value) ? (value as ClassKey) : 'unknown';
}

export function universeFrom(
  systems: SystemInfo[],
  holes: HoleType[],
  classes: Record<string, string> = {},
  generatedAt = '',
  gates: [number, number][] = [],
): Universe {
  const u: Universe = {
    systems: new Map(),
    byName: new Map(),
    holes: new Map(),
    classes: new Map(Object.entries(classes)),
    gates: new Map(),
    generatedAt,
  };
  const link = (a: number, b: number) => {
    const list = u.gates.get(a);
    if (list) list.push(b);
    else u.gates.set(a, [b]);
  };
  for (const [a, b] of gates) {
    link(a, b);
    link(b, a);
  }
  for (const s of systems) {
    u.systems.set(s.id, s);
    u.byName.set(s.name.toLowerCase(), s);
  }
  for (const h of holes) u.holes.set(h.code.toUpperCase(), h);
  return u;
}

export function loadUniverse(path: string = DEFAULT_UNIVERSE_PATH): Universe {
  const file = JSON.parse(readFileSync(path, 'utf8')) as UniverseFile;
  const systems = file.systems.map(([id, name, cls, sec, region, effect, statics, shattered]): SystemInfo => ({
    id, name, cls: asClassKey(cls), sec, region, effect, statics, shattered: shattered === 1,
  }));
  const holes = Object.entries(file.holes).map(([code, h]): HoleType => ({
    code,
    dest: h.dest === null ? null : asClassKey(h.dest),
    src: h.src.map(asClassKey),
    isStatic: h.isStatic,
    totalMass: h.totalMass,
    jumpMass: h.jumpMass,
    lifetimeHours: h.lifetimeHours,
    massRegen: h.massRegen,
  }));
  return universeFrom(systems, holes, file.classes, file.generatedAt, file.gates ?? []);
}

// ---------------------------------------------------------------------------
// Tripwire's "generic" far sides. When a scanner knows a hole leads to, say,
// highsec but not which system, Tripwire stores a small integer in systemID
// that indexes this list (app/js/tripwire/genericSystemTypes.js upstream).
// Real solar system IDs start at 30,000,000, so the two never collide.
// ---------------------------------------------------------------------------

export const GENERIC_SYSTEM_TYPES: readonly string[] = [
  'Null-Sec', 'Low-Sec', 'High-Sec',
  'Class-1', 'Class-2', 'Class-3', 'Class-4', 'Class-5', 'Class-6', 'Class-13',
  'Triglavian',
  'Unknown', 'Unknown (small)', 'Dangerous',
  'Class-14', 'Class-15', 'Class-16', 'Class-17', 'Class-18',
];

export const REAL_SYSTEM_MIN = 30_000_000;

export function isRealSystemId(id: number | null | undefined): id is number {
  return typeof id === 'number' && id >= REAL_SYSTEM_MIN;
}

export function genericLabel(id: number | null): string {
  if (id === null) return 'Unknown';
  return GENERIC_SYSTEM_TYPES[id] ?? `Unknown (${id})`;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

function normaliseQuery(query: string): string {
  const q = query.trim();
  // Six bare digits is a J-number typed without its J.
  return (/^\d{6}$/.test(q) ? `J${q}` : q).toLowerCase();
}

/** Exact (case-insensitive) match, else a unique prefix match, else undefined. */
export function findSystem(u: Universe, query: string): SystemInfo | undefined {
  const key = normaliseQuery(query);
  if (!key) return undefined;
  const exact = u.byName.get(key);
  if (exact) return exact;
  const matches = searchSystems(u, key, 2);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Prefix matches sorted by name, for autocomplete. */
export function searchSystems(u: Universe, query: string, limit = 25): SystemInfo[] {
  const key = normaliseQuery(query);
  if (!key) return [];
  const out: SystemInfo[] = [];
  for (const [name, s] of u.byName) {
    if (name.startsWith(key)) out.push(s);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** Security the way the client shows it: 0.0 < sec < 0.05 displays as 0.1. */
export function secDisplay(sec: number): string {
  if (sec > 0 && sec < 0.05) return '0.1';
  const r = Math.round(sec * 10) / 10;
  return (Object.is(r, -0) ? 0 : r).toFixed(1);
}

export function classLabel(cls: ClassKey): string {
  switch (cls) {
    case 'hs': return 'HS';
    case 'ls': return 'LS';
    case 'ns': return 'NS';
    case 'pochven': return 'Pochven';
    case 'thera': return 'C12';
    case 'sentinel': case 'barbican': case 'vidette': case 'conflux': case 'redoubt': return 'Drifter';
    case 'unknown': return '?';
    default: return cls.toUpperCase();
  }
}

export function isKSpace(cls: ClassKey): boolean {
  return cls === 'hs' || cls === 'ls' || cls === 'ns' || cls === 'pochven';
}

/** Somewhere a wormholer would call "an exit": k-space or Thera. */
export function isExit(cls: ClassKey): boolean {
  return isKSpace(cls) || cls === 'thera';
}

/** "C4", "C13", "HS 0.9", "LS 0.3", "NS -0.2", "Thera". */
export function systemBadge(s: SystemInfo): string {
  if (isKSpace(s.cls) && s.sec !== null) return `${classLabel(s.cls)} ${secDisplay(s.sec)}`;
  const base = classLabel(s.cls);
  return s.shattered && s.cls !== 'c13' && s.cls !== 'thera' ? `${base} shattered` : base;
}

/** Mass in the units pilots use: 375m, 2b. */
export function fmtMass(kg: number | null): string {
  if (kg === null) return '?';
  const trim = (n: number) => (Math.round(n * 10) / 10).toString();
  return kg >= 1e9 ? `${trim(kg / 1e9)}b` : `${trim(kg / 1e6)}m`;
}

/** "C247 → C3 · 2b total · 375m/jump · 16h", or null for an unknown code. */
export function describeHole(u: Universe, code: string): string | null {
  const h = u.holes.get(code.toUpperCase());
  if (!h) return null;
  const dest = h.dest ? classLabel(h.dest) : '?';
  const life = h.lifetimeHours === null ? '?' : `${h.lifetimeHours}h`;
  return `${h.code} → ${dest} · ${fmtMass(h.totalMass)} total · ${fmtMass(h.jumpMass)}/jump · ${life}`;
}
