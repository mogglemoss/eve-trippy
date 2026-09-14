/**
 * Routing across the chain *and* k-space. Wormhole connections come from the
 * live chain; stargates come from the static universe.
 *
 * The cost model matches Aperture's route planner so both tools agree:
 * every jump costs 1 plus a safety penalty for the system entered —
 * `shortest` adds nothing; `safer` adds 50 for lowsec and 100 for null,
 * Pochven and J-space; `less_safe` inverts that (+50 for highsec).
 * Penalties are finite, so a reachable destination is never reported as
 * unreachable, and `jumps` is always the true hop count.
 */
import type { ScoutHole } from '../scout.js';
import { isKSpace, isRealSystemId, type Universe } from '../universe/index.js';
import { farSide, type Chain, type Connection } from './graph.js';

export type Mode = 'shortest' | 'safer' | 'less_safe';
export type ShipClass = 's' | 'm' | 'l' | 'xl';

export interface RoutePrefs {
  mode: Mode;
  /** Smallest hole the ship fits through; null = any. */
  minShip: ShipClass | null;
  skipEol: boolean;
  skipCrit: boolean;
  skipReduced: boolean;
  /** System IDs to route around; endpoints are always allowed. */
  avoid: ReadonlySet<number>;
  /** EVE-Scout's public Thera/Turnur holes, usable as extra edges. */
  scout?: ScoutHole[];
}

export const DEFAULT_PREFS: RoutePrefs = {
  mode: 'shortest', minShip: null, skipEol: false, skipCrit: false, skipReduced: false, avoid: new Set(),
};

export type Step =
  | { kind: 'hole'; c: Connection; to: number }
  | { kind: 'gate'; to: number }
  | { kind: 'scout'; hole: ScoutHole; to: number };

export interface Route {
  from: number;
  to: number;
  steps: Step[];
  jumps: number;
  holes: number;
  gates: number;
}

/** Capsuleers leaving Zarzakh are locked to their arrival gate for six hours; never route through it. */
export const ZARZAKH = 30_100_000;

const SHIP_RANK: Record<ShipClass, number> = { s: 0, m: 1, l: 2, xl: 3 };

/** Hole size class from the max mass per jump, the way the client bands them. */
export function shipClassForJumpMass(kg: number | null): ShipClass | null {
  if (kg === null) return null;
  if (kg <= 5_000_000) return 's';
  if (kg <= 62_000_000) return 'm';
  if (kg <= 375_000_000) return 'l';
  return 'xl';
}

export function safetyPenalty(u: Universe, systemId: number, mode: Mode): number {
  if (mode === 'shortest') return 0;
  const cls = u.systems.get(systemId)?.cls;
  const hs = cls === 'hs';
  const ls = cls === 'ls';
  if (mode === 'safer') return hs ? 0 : ls ? 50 : 100;
  return hs ? 50 : 0; // less_safe
}

/** Why a hole is unusable under these prefs, or null if it passes. */
export function holeBlocked(c: Connection, u: Universe, prefs: RoutePrefs): string | null {
  if (prefs.skipEol && c.life === 'critical') return 'EOL';
  if (prefs.skipCrit && c.mass === 'critical') return 'crit mass';
  if (prefs.skipReduced && c.mass !== 'stable') return 'reduced mass';
  if (prefs.minShip && c.type) {
    const size = shipClassForJumpMass(u.holes.get(c.type)?.jumpMass ?? null);
    if (size && SHIP_RANK[size] < SHIP_RANK[prefs.minShip]) return `too small (${size})`;
  }
  return null;
}

/** Small binary min-heap keyed on cost; the frontier can reach thousands in k-space. */
class Heap {
  private a: [number, number][] = [];
  get size() { return this.a.length; }
  push(cost: number, id: number): void {
    const a = this.a;
    a.push([cost, id]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]![0] <= a[i]![0]) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): [number, number] | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l]![0] < a[m]![0]) m = l;
        if (r < a.length && a[r]![0] < a[m]![0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

const SCOUT_SIZE_RANK: Record<string, number> = { small: 0, medium: 1, large: 2, xlarge: 3, capital: 3 };

/** Why an EVE-Scout hole is unusable under these prefs, or null. */
export function scoutBlocked(h: ScoutHole, prefs: RoutePrefs): string | null {
  if (prefs.skipEol && h.remainingHours !== null && h.remainingHours <= 4) return 'EOL';
  if (prefs.minShip && h.maxShipSize) {
    const rank = SCOUT_SIZE_RANK[h.maxShipSize.toLowerCase()];
    if (rank !== undefined && rank < SHIP_RANK[prefs.minShip]) return `too small (${h.maxShipSize})`;
  }
  return null;
}

/** Fewest (or safest) jumps from one system to another, or null. Empty steps when from === to. */
export function findRoute(chain: Chain, u: Universe, from: number, to: number, prefs: RoutePrefs = DEFAULT_PREFS): Route | null {
  if (from === to) return { from, to, steps: [], jumps: 0, holes: 0, gates: 0 };
  const blocked = (id: number) => id !== from && id !== to && (prefs.avoid.has(id) || id === ZARZAKH);

  const dist = new Map<number, number>([[from, 0]]);
  const prev = new Map<number, Step & { via: number }>();
  const done = new Set<number>();
  const frontier = new Heap();
  frontier.push(0, from);

  // EVE-Scout holes are bidirectional edges hub <-> out.
  const scoutAdj = new Map<number, { hole: ScoutHole; to: number }[]>();
  for (const h of prefs.scout ?? []) {
    if (scoutBlocked(h, prefs)) continue;
    for (const [a, b] of [[h.hubId, h.outId], [h.outId, h.hubId]] as const) {
      const list = scoutAdj.get(a);
      if (list) list.push({ hole: h, to: b });
      else scoutAdj.set(a, [{ hole: h, to: b }]);
    }
  }

  while (frontier.size) {
    const [d, sys] = frontier.pop()!;
    if (done.has(sys)) continue;
    done.add(sys);
    if (sys === to) break;

    const relax = (next: number, step: Step) => {
      if (!isRealSystemId(next) || done.has(next) || blocked(next)) return;
      const nd = d + 1 + safetyPenalty(u, next, prefs.mode);
      if (nd < (dist.get(next) ?? Infinity)) {
        dist.set(next, nd);
        prev.set(next, { ...step, via: sys });
        frontier.push(nd, next);
      }
    };
    for (const e of scoutAdj.get(sys) ?? []) relax(e.to, { kind: 'scout', hole: e.hole, to: e.to });
    for (const c of chain.adj.get(sys) ?? []) {
      if (holeBlocked(c, u, prefs)) continue;
      const next = farSide(c, sys);
      if (isRealSystemId(next)) relax(next, { kind: 'hole', c, to: next });
    }
    for (const next of u.gates.get(sys) ?? []) relax(next, { kind: 'gate', to: next });
  }

  if (!prev.has(to)) return null;
  const steps: Step[] = [];
  let cur = to;
  while (cur !== from) {
    const { via, ...step } = prev.get(cur)!;
    steps.unshift(step);
    cur = via;
  }
  return {
    from, to, steps,
    jumps: steps.length,
    holes: steps.filter((s) => s.kind === 'hole' || s.kind === 'scout').length,
    gates: steps.filter((s) => s.kind === 'gate').length,
  };
}

export { isKSpace };
