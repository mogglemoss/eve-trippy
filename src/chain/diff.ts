/**
 * What changed between two looks at the chain. The watcher keeps the compact
 * `ConnState` form on disk so a restart does not re-announce the whole map.
 */
import type { Life, Mass } from '../tripwire/types.js';
import { isRealSystemId } from '../universe/index.js';
import type { Chain, Connection } from './graph.js';

export interface ConnState {
  a: number | null;
  b: number | null;
  sigA: string | null;
  sigB: string | null;
  type: string | null;
  life: Life;
  mass: Mass;
}

export type WatchState = Record<string, ConnState>;

export type ChainEvent =
  | { kind: 'connected'; c: Connection }
  | { kind: 'ghost'; c: Connection }
  | { kind: 'mass'; c: Connection; from: Mass }
  | { kind: 'identified'; c: Connection; from: ConnState };

const MASS_RANK: Record<Mass, number> = { stable: 0, destab: 1, critical: 2 };

export function stateOf(chain: Chain): WatchState {
  const out: WatchState = {};
  for (const c of chain.connections.values()) {
    out[String(c.id)] = { a: c.a, b: c.b, sigA: c.sigA.sigId, sigB: c.sigB.sigId, type: c.type, life: c.life, mass: c.mass };
  }
  return out;
}

export function diffChain(prev: WatchState, next: Chain): ChainEvent[] {
  const events: ChainEvent[] = [];
  for (const c of next.connections.values()) {
    const before = prev[String(c.id)];
    if (!before) {
      events.push({ kind: 'connected', c });
      continue;
    }
    const identifiedA = !isRealSystemId(before.a) && isRealSystemId(c.a);
    const identifiedB = !isRealSystemId(before.b) && isRealSystemId(c.b);
    if (identifiedA || identifiedB) events.push({ kind: 'identified', c, from: before });
    if (MASS_RANK[c.mass] > MASS_RANK[before.mass]) events.push({ kind: 'mass', c, from: before.mass });
  }
  return events;
}
