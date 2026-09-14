/**
 * "Where is the nearest chain?" — from any k-space system, the closest mapped
 * systems by stargate, across every chain on the map.
 */
import type { Universe } from '../universe/index.js';
import type { Chain } from './graph.js';
import { components } from './graph.js';

export interface NearResult {
  system: number;
  gates: number;
  /** Gate path from the origin to the mapped system, origin excluded. */
  path: number[];
  /** Size of the chain fragment this system belongs to. */
  fragmentSize: number;
}

export function nearestMapped(chain: Chain, u: Universe, from: number, limit = 5, maxGates = 30): NearResult[] {
  const mapped = new Set(chain.adj.keys());
  const fragmentOf = new Map<number, number>();
  for (const group of components(chain)) for (const id of group) fragmentOf.set(id, group.length);

  const out: NearResult[] = [];
  const seen = new Set<number>([from]);
  const prev = new Map<number, number>();
  let frontier = [from];
  let depth = 0;
  if (mapped.has(from)) out.push({ system: from, gates: 0, path: [], fragmentSize: fragmentOf.get(from) ?? 1 });
  while (frontier.length && depth < maxGates && out.length < limit) {
    depth += 1;
    const next: number[] = [];
    for (const sys of frontier) {
      for (const n of u.gates.get(sys) ?? []) {
        if (seen.has(n)) continue;
        seen.add(n);
        prev.set(n, sys);
        next.push(n);
        if (mapped.has(n) && out.length < limit) {
          const path: number[] = [];
          for (let cur = n; cur !== from; cur = prev.get(cur)!) path.unshift(cur);
          out.push({ system: n, gates: depth, path, fragmentSize: fragmentOf.get(n) ?? 1 });
        }
      }
    }
    frontier = next;
  }
  return out;
}

export interface Proximity {
  /** The k-space system that just became reachable. */
  exit: number;
  gates: number;
  /** What it is near: a watched system or a watched region. */
  systemId: number | null;
  region: string | null;
}

/**
 * Which watches a newly mapped k-space system falls inside: within N gates of
 * a watched system, or inside a watched region (any gate distance, 0 = in it).
 */
export function proximities(
  u: Universe, exit: number, watches: { systemId: number | null; region: string | null; gates: number }[],
): Proximity[] {
  const out: Proximity[] = [];
  const exitSys = u.systems.get(exit);
  if (!exitSys) return out;
  const maxGates = Math.max(0, ...watches.map((w) => w.gates));
  // Gate distances from the exit, bounded by the widest watch.
  const dist = new Map<number, number>([[exit, 0]]);
  let frontier = [exit];
  for (let d = 1; d <= maxGates && frontier.length; d++) {
    const next: number[] = [];
    for (const sys of frontier) for (const n of u.gates.get(sys) ?? []) {
      if (dist.has(n)) continue;
      dist.set(n, d);
      next.push(n);
    }
    frontier = next;
  }
  for (const w of watches) {
    if (w.systemId !== null) {
      const d = dist.get(w.systemId);
      if (d !== undefined && d <= w.gates) out.push({ exit, gates: d, systemId: w.systemId, region: null });
    } else if (w.region && exitSys.region.toLowerCase() === w.region.toLowerCase()) {
      out.push({ exit, gates: 0, systemId: null, region: exitSys.region });
    }
  }
  return out;
}
