/**
 * Builds data/universe.json — the static map Trippy consults for names, classes,
 * security, effects, statics and wormhole types.
 *
 * Sources:
 *   - mapSolarSystems.csv, mapRegions.csv and mapSolarSystemJumps.csv from the
 *     EVE SDE (systems, regions, stargates), in ./sde by default; pass
 *     `--sde <dir>` to point elsewhere. Fuzzwork publishes the SDE as CSV.
 *   - https://anoik.is/static/static.json for W-space classes, effects, statics
 *     and every wormhole type. Cached in .cache/; pass `--refresh` to re-fetch.
 *
 * Run on CCP patch days. The output is committed so the bot needs neither
 * source at runtime.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asClassKey, type SystemRow, type UniverseFile } from '../src/universe/index.js';
import { USER_AGENT } from '../src/ua.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (flag: string, fallback: string): string => {
  const i = argv.indexOf(flag);
  const v = argv[i + 1];
  return i >= 0 && v ? v : fallback;
};
const SDE_DIR = opt('--sde', join(ROOT, 'sde'));
const REFRESH = argv.includes('--refresh');
const ANOIK_URL = 'https://anoik.is/static/static.json';
const CACHE = join(ROOT, '.cache', 'anoik.json');
const OUT = join(ROOT, 'data', 'universe.json');
const POCHVEN_REGION = 10_000_070;
const SHATTERED_PLANET_TYPE = 30_889;

interface AnoikSystem {
  solarSystemID: number; solarSystemName: string; regionID: number;
  effectName: string | null; statics: string[]; wormholeClass: string; cels?: unknown[][];
}
interface AnoikHole {
  dest: string | null; src: string[] | null; static: boolean | null;
  total_mass: number | null; max_mass_per_jump: number | null; lifetime: number | null; mass_regen: number | null;
}
interface Anoik {
  version: number;
  systems: Record<string, AnoikSystem>;
  wormholes: Record<string, AnoikHole>;
  wormholeclasses: Record<string, { title: string }>;
  regions: Record<string, string>;
}

function csv(path: string): Record<string, string>[] {
  const [head, ...rows] = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  if (!head) throw new Error(`${path} is empty`);
  const cols = head.split(',');
  return rows.map((r) => {
    const cells = r.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']));
  });
}

async function loadAnoik(): Promise<Anoik> {
  if (!REFRESH && existsSync(CACHE)) return JSON.parse(readFileSync(CACHE, 'utf8')) as Anoik;
  const res = await fetch(ANOIK_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`anoik.is answered ${res.status}`);
  const text = await res.text();
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, text);
  return JSON.parse(text) as Anoik;
}

function classify(sec: number, regionID: number): string {
  if (regionID === POCHVEN_REGION) return 'pochven';
  if (sec >= 0.45) return 'hs';
  if (sec > 0) return 'ls';
  return 'ns';
}

const isShattered = (cels: unknown[][] | undefined): boolean =>
  !!cels?.some((row) => row[1] === SHATTERED_PLANET_TYPE);

const round3 = (n: number) => Math.round(n * 1000) / 1000;

const a = await loadAnoik();
const wById = new Map(Object.values(a.systems).map((s) => [s.solarSystemID, s]));

const regions = new Map<number, string>();
for (const r of csv(join(SDE_DIR, 'mapRegions.csv'))) regions.set(Number(r.regionID), r.regionName ?? '');
for (const [id, name] of Object.entries(a.regions)) if (!regions.has(Number(id))) regions.set(Number(id), name);

const rows: SystemRow[] = [];
const seen = new Set<number>();
const badClasses = new Set<string>();

function wRow(w: AnoikSystem, fallbackName?: string): SystemRow {
  if (asClassKey(w.wormholeClass) === 'unknown') badClasses.add(w.wormholeClass);
  return [
    w.solarSystemID, w.solarSystemName || fallbackName || String(w.solarSystemID), w.wormholeClass, null,
    regions.get(w.regionID) ?? String(w.regionID), w.effectName ?? null, w.statics ?? [], isShattered(w.cels) ? 1 : 0,
  ];
}

for (const r of csv(join(SDE_DIR, 'mapSolarSystems.csv'))) {
  const id = Number(r.solarSystemID);
  const regionID = Number(r.regionID);
  if (!id || regionID >= 12_000_000) continue; // abyssal and other non-map regions
  seen.add(id);
  const w = wById.get(id);
  if (w) {
    rows.push(wRow(w, r.solarSystemName));
  } else {
    const sec = Number(r.security);
    const cls = regionID >= 11_000_000 ? 'unknown' : classify(sec, regionID);
    rows.push([id, r.solarSystemName ?? '', cls, round3(sec), regions.get(regionID) ?? '', null, [], 0]);
  }
}
for (const w of wById.values()) if (!seen.has(w.solarSystemID)) rows.push(wRow(w));
rows.sort((x, y) => x[0] - y[0]);

const holes: UniverseFile['holes'] = {};
for (const [code, h] of Object.entries(a.wormholes)) {
  holes[code.toUpperCase()] = {
    dest: h.dest, src: h.src ?? [], isStatic: h.static === true,
    totalMass: h.total_mass, jumpMass: h.max_mass_per_jump, lifetimeHours: h.lifetime, massRegen: h.mass_regen,
  };
}

const known = new Set(rows.map((r) => r[0]));
const gateSet = new Set<string>();
const gates: [number, number][] = [];
for (const j of csv(join(SDE_DIR, 'mapSolarSystemJumps.csv'))) {
  const a = Number(j.fromSolarSystemID);
  const b = Number(j.toSolarSystemID);
  if (!known.has(a) || !known.has(b)) continue;
  const key = a < b ? `${a}-${b}` : `${b}-${a}`;
  if (gateSet.has(key)) continue;
  gateSet.add(key);
  gates.push(a < b ? [a, b] : [b, a]);
}

const out: UniverseFile = {
  version: 1,
  generatedAt: new Date().toISOString(),
  classes: Object.fromEntries(Object.entries(a.wormholeclasses).map(([k, v]) => [k, v.title])),
  holes,
  systems: rows,
  gates,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));

const wspace = rows.filter((r) => r[3] === null).length;
console.log(`wrote ${OUT}`);
console.log(`  ${rows.length} systems (${wspace} W-space, ${rows.length - wspace} k-space), ${gates.length} stargates, ${Object.keys(holes).length} wormhole types, anoik.is v${a.version}`);
if (badClasses.size) console.warn(`  unrecognised class keys: ${[...badClasses].join(', ')}`);
