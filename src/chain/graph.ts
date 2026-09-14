/**
 * The chain as a graph. Tripwire stores a wormhole as a row joining two
 * signature rows; each signature knows its system. A connection here is that
 * triple, resolved. Systems are keyed by solar system ID; Tripwire's generic
 * far sides ("High-Sec", "Class-3") and unknowns are leaves that never expand.
 */
import type { Life, Mass, ParentSide, Signature, Snapshot, Wormhole } from '../tripwire/types.js';
import { isRealSystemId } from '../universe/index.js';

export interface Connection {
  id: number;
  /** initial side */
  sigA: Signature;
  /** secondary side */
  sigB: Signature;
  a: number | null;
  b: number | null;
  type: string | null;
  parent: ParentSide | null;
  life: Life;
  mass: Mass;
  /** Earliest expiry of the two ends, ignoring ends with no lifetime set. */
  expiresAt: Date | null;
  updatedAt: Date;
  createdBy: string;
  modifiedBy: string;
}

export interface Chain {
  fetchedAt: Date;
  signatures: Map<number, Signature>;
  sigsBySystem: Map<number, Signature[]>;
  connections: Map<number, Connection>;
  /** Adjacency for real systems only. */
  adj: Map<number, Connection[]>;
  /** Wormhole rows whose signatures were missing from the snapshot. */
  skipped: Wormhole[];
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function buildChain(snap: Snapshot): Chain {
  const signatures = new Map(snap.signatures.map((s) => [s.id, s] as const));
  const sigsBySystem = new Map<number, Signature[]>();
  for (const s of snap.signatures) if (isRealSystemId(s.systemId)) push(sigsBySystem, s.systemId, s);

  const connections = new Map<number, Connection>();
  const adj = new Map<number, Connection[]>();
  const skipped: Wormhole[] = [];

  for (const w of snap.wormholes) {
    const sigA = signatures.get(w.initialId);
    const sigB = signatures.get(w.secondaryId);
    if (!sigA || !sigB) {
      skipped.push(w);
      continue;
    }
    const lives = [sigA, sigB].filter((s) => s.lifeLengthSec > 0).map((s) => s.expiresAt.getTime());
    const c: Connection = {
      id: w.id,
      sigA,
      sigB,
      a: sigA.systemId,
      b: sigB.systemId,
      type: w.type,
      parent: w.parent,
      life: w.life,
      mass: w.mass,
      expiresAt: lives.length ? new Date(Math.min(...lives)) : null,
      updatedAt: new Date(Math.max(sigA.modifiedAt.getTime(), sigB.modifiedAt.getTime())),
      createdBy: sigA.createdBy || sigB.createdBy,
      modifiedBy: sigA.modifiedAt >= sigB.modifiedAt ? sigA.modifiedBy : sigB.modifiedBy,
    };
    connections.set(c.id, c);
    if (isRealSystemId(c.a)) push(adj, c.a, c);
    if (isRealSystemId(c.b) && c.b !== c.a) push(adj, c.b, c);
  }

  for (const list of adj.values()) list.sort(byNearSig);
  for (const list of sigsBySystem.values()) list.sort((x, y) => (x.sigId ?? '~').localeCompare(y.sigId ?? '~'));

  return { fetchedAt: snap.fetchedAt, signatures, sigsBySystem, connections, adj, skipped };
}

const byNearSig = (x: Connection, y: Connection) => x.id - y.id;

/** The system at the other end of `c` from `sys`. */
export function farSide(c: Connection, sys: number): number | null {
  return c.a === sys ? c.b : c.a;
}

export function nearSig(c: Connection, sys: number): Signature {
  return c.a === sys ? c.sigA : c.sigB;
}

export function farSig(c: Connection, sys: number): Signature {
  return c.a === sys ? c.sigB : c.sigA;
}

/** True when `sys` is the side that holds the named (non-K162) hole. */
export function isParentSide(c: Connection, sys: number): boolean | null {
  if (!c.parent) return null;
  return (c.parent === 'initial') === (c.a === sys);
}

/**
 * The hole code as a pilot in `sys` would see it on d-scan: the named type on
 * the parent side, K162 on the other (with the origin type in brackets when
 * known). Mirrors Tripwire's formattedType.
 */
export function holeLabel(c: Connection, sys: number): string {
  const named = c.type && c.type !== 'K162' ? c.type : null;
  const parentHere = isParentSide(c, sys);
  if (parentHere === null || parentHere) return named ?? '???';
  return named ? `K162 (${named})` : 'K162';
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

export interface TreeNode {
  /** Real system ID, a generic index, or null for a fully unknown far side. */
  system: number | null;
  via: Connection | null;
  depth: number;
  children: TreeNode[];
  /** Connections leading to a system already placed elsewhere in the tree. */
  loops: Connection[];
}

/** Breadth-first spanning tree from `root`, so every system sits at its fewest jumps. */
export function spanningTree(chain: Chain, root: number): TreeNode {
  const rootNode: TreeNode = { system: root, via: null, depth: 0, children: [], loops: [] };
  const seen = new Set<number>([root]);
  const usedConnections = new Set<number>();
  const queue: TreeNode[] = [rootNode];
  while (queue.length) {
    const node = queue.shift()!;
    const sys = node.system;
    if (!isRealSystemId(sys)) continue;
    for (const c of chain.adj.get(sys) ?? []) {
      if (usedConnections.has(c.id)) continue;
      usedConnections.add(c.id);
      const far = farSide(c, sys);
      if (isRealSystemId(far)) {
        if (seen.has(far)) {
          node.loops.push(c);
          continue;
        }
        seen.add(far);
        const child: TreeNode = { system: far, via: c, depth: node.depth + 1, children: [], loops: [] };
        node.children.push(child);
        queue.push(child);
      } else {
        node.children.push({ system: far, via: c, depth: node.depth + 1, children: [], loops: [] });
      }
    }
  }
  return rootNode;
}

export function reachable(chain: Chain, root: number): Set<number> {
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length) {
    const sys = queue.shift()!;
    for (const c of chain.adj.get(sys) ?? []) {
      const far = farSide(c, sys);
      if (isRealSystemId(far) && !seen.has(far)) {
        seen.add(far);
        queue.push(far);
      }
    }
  }
  return seen;
}

/** Fewest-jumps path as the connections to take, or null when unreachable. Empty when from === to. */
export function shortestPath(chain: Chain, from: number, to: number): Connection[] | null {
  if (from === to) return [];
  const prev = new Map<number, { sys: number; via: Connection }>();
  const seen = new Set<number>([from]);
  const queue = [from];
  while (queue.length) {
    const sys = queue.shift()!;
    for (const c of chain.adj.get(sys) ?? []) {
      const far = farSide(c, sys);
      if (!isRealSystemId(far) || seen.has(far)) continue;
      seen.add(far);
      prev.set(far, { sys, via: c });
      if (far === to) {
        const path: Connection[] = [];
        let cur = to;
        while (cur !== from) {
          const step = prev.get(cur)!;
          path.unshift(step.via);
          cur = step.sys;
        }
        return path;
      }
      queue.push(far);
    }
  }
  return null;
}

/** Connected groups of real systems, largest first. */
export function components(chain: Chain): number[][] {
  const seen = new Set<number>();
  const out: number[][] = [];
  for (const sys of chain.adj.keys()) {
    if (seen.has(sys)) continue;
    const group = [...reachable(chain, sys)];
    for (const s of group) seen.add(s);
    out.push(group.sort((x, y) => x - y));
  }
  return out.sort((x, y) => y.length - x.length);
}

/** Systems the tree actually shows (real IDs only). */
export function treeSystems(node: TreeNode, into = new Set<number>()): Set<number> {
  if (isRealSystemId(node.system)) into.add(node.system);
  for (const child of node.children) treeSystems(child, into);
  return into;
}
