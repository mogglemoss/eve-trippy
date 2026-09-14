/**
 * Ghost signatures: wormhole rows the automapper created while following a
 * pilot who was, in fact, taking gates. Both ends sit in k-space, neither
 * carries a signature ID or a hole type, and the two systems are within a
 * few gate jumps of each other — the pilot crossed them between two polls.
 *
 * Rows that pass the first tests but are far apart by gate are probably real
 * holes nobody has identified yet: reported separately as "unidentified".
 */
import { isKSpace, isRealSystemId, type Universe } from '../universe/index.js';
import type { Chain, Connection } from './graph.js';

export const GHOST_MAX_GATES = 3;

/** Gate distance between two systems, or null when farther than `max` (or disconnected). */
export function gateDistance(u: Universe, a: number, b: number, max: number): number | null {
  if (a === b) return 0;
  const seen = new Set<number>([a]);
  let frontier = [a];
  for (let d = 1; d <= max && frontier.length; d++) {
    const next: number[] = [];
    for (const sys of frontier) for (const n of u.gates.get(sys) ?? []) {
      if (seen.has(n)) continue;
      if (n === b) return d;
      seen.add(n);
      next.push(n);
    }
    frontier = next;
  }
  return null;
}

/** K-space both ends, no sig IDs, no named type: the automapper's signature, whatever the distance. */
export function isUnidentifiedKspaceHole(c: Connection, u: Universe): boolean {
  if (!isRealSystemId(c.a) || !isRealSystemId(c.b)) return false;
  const a = u.systems.get(c.a);
  const b = u.systems.get(c.b);
  if (!a || !b || !isKSpace(a.cls) || !isKSpace(b.cls)) return false;
  const noSigs = !c.sigA.sigId && !c.sigB.sigId;
  const noType = !c.type || c.type === 'K162';
  return noSigs && noType;
}

export function isGhost(c: Connection, u: Universe, maxGates = GHOST_MAX_GATES): boolean {
  if (!isUnidentifiedKspaceHole(c, u)) return false;
  return gateDistance(u, c.a!, c.b!, maxGates) !== null;
}

export interface GhostReport {
  /** Automapper artefacts: delete these. */
  ghosts: Connection[];
  /** Real-looking k-space holes with no IDs: scan and identify these. */
  unidentified: Connection[];
}

export function ghostReport(chain: Chain, u: Universe, maxGates = GHOST_MAX_GATES): GhostReport {
  const ghosts: Connection[] = [];
  const unidentified: Connection[] = [];
  for (const c of chain.connections.values()) {
    if (!isUnidentifiedKspaceHole(c, u)) continue;
    (gateDistance(u, c.a!, c.b!, maxGates) !== null ? ghosts : unidentified).push(c);
  }
  const newest = (x: Connection, y: Connection) => y.updatedAt.getTime() - x.updatedAt.getTime();
  return { ghosts: ghosts.sort(newest), unidentified: unidentified.sort(newest) };
}

export function ghosts(chain: Chain, u: Universe, maxGates = GHOST_MAX_GATES): Connection[] {
  return ghostReport(chain, u, maxGates).ghosts;
}
