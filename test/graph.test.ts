import { describe, expect, it } from 'vitest';
import { buildChain, components, farSide, holeLabel, reachable, shortestPath, spanningTree, treeSystems } from '../src/chain/graph.js';
import { AMARR, C3, C5A, C5B, HOME, JITA, snapshot } from './fixtures.js';

describe('buildChain', () => {
  it('links signatures into connections and drops dangling wormhole rows', () => {
    const chain = buildChain(snapshot());
    expect(chain.connections.size).toBe(5);
    expect(chain.skipped.map((w) => w.id)).toEqual([106]);
    expect([...chain.adj.keys()].sort()).toEqual([HOME, C3, JITA, AMARR, C5A, C5B].sort());
  });

  it('keeps generic far sides out of adjacency', () => {
    const chain = buildChain(snapshot());
    expect(chain.adj.has(2)).toBe(false);
    const c = chain.connections.get(103)!;
    expect(farSide(c, HOME)).toBe(2);
  });

  it('takes the earliest expiry across both ends, ignoring ends with no lifetime', () => {
    const chain = buildChain(snapshot());
    expect(chain.connections.get(102)!.expiresAt?.toISOString()).toBe('2026-09-07T14:00:00.000Z');
    expect(chain.connections.get(103)!.expiresAt).not.toBeNull(); // generic side has lifeLength 0, home side counts
  });
});

describe('holeLabel', () => {
  it('shows the named type on the parent side and K162 on the other', () => {
    const chain = buildChain(snapshot());
    const c = chain.connections.get(101)!;
    expect(holeLabel(c, HOME)).toBe('C247');
    expect(holeLabel(c, C3)).toBe('K162 (C247)');
  });

  it('handles parent on the secondary side with only K162 known', () => {
    const chain = buildChain(snapshot());
    const c = chain.connections.get(104)!;
    expect(holeLabel(c, AMARR)).toBe('???');
    expect(holeLabel(c, C3)).toBe('K162');
  });

  it('falls back to ??? with no parent and no type', () => {
    const chain = buildChain(snapshot());
    expect(holeLabel(chain.connections.get(103)!, HOME)).toBe('???');
  });
});

describe('traversal', () => {
  it('builds a breadth-first tree with generic leaves', () => {
    const chain = buildChain(snapshot());
    const tree = spanningTree(chain, HOME);
    expect(tree.children.map((n) => n.system)).toEqual([C3, 2]);
    const c3 = tree.children[0]!;
    expect(c3.children.map((n) => n.system).sort()).toEqual([JITA, AMARR].sort());
    expect([...treeSystems(tree)].sort()).toEqual([HOME, C3, JITA, AMARR].sort());
  });

  it('records loops instead of repeating systems', () => {
    const snap = snapshot();
    // second hole from home straight to Jita
    snap.signatures.push(
      { ...snap.signatures[0]!, id: 20, sigId: 'LOO001' },
      { ...snap.signatures[3]!, id: 21, sigId: 'LOO002' },
    );
    snap.wormholes.push({ id: 120, initialId: 20, secondaryId: 21, type: 'B274', parent: 'initial', life: 'stable', mass: 'stable' });
    const tree = spanningTree(buildChain(snap), HOME);
    const jitaDirect = tree.children.find((n) => n.system === JITA);
    expect(jitaDirect).toBeDefined();
    const c3 = tree.children.find((n) => n.system === C3)!;
    expect(c3.loops.map((c) => c.id)).toEqual([102]);
  });

  it('finds the shortest route and reports unreachable', () => {
    const chain = buildChain(snapshot());
    expect(shortestPath(chain, HOME, JITA)!.map((c) => c.id)).toEqual([101, 102]);
    expect(shortestPath(chain, HOME, HOME)).toEqual([]);
    expect(shortestPath(chain, HOME, C5A)).toBeNull();
    expect([...reachable(chain, C5A)].sort()).toEqual([C5A, C5B]);
  });

  it('lists fragments largest first', () => {
    const groups = components(buildChain(snapshot()));
    expect(groups.map((g) => g.length)).toEqual([4, 2]);
  });
});
