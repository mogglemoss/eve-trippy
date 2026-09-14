import { describe, expect, it } from 'vitest';
import { diffChain, stateOf } from '../src/chain/diff.js';
import { buildChain } from '../src/chain/graph.js';
import { JITA, snapshot } from './fixtures.js';

describe('diffChain', () => {
  it('is quiet when nothing changed', () => {
    const chain = buildChain(snapshot());
    expect(diffChain(stateOf(chain), chain)).toEqual([]);
  });

  it('announces new, gone, eol, mass and identified', () => {
    const before = buildChain(snapshot());
    const after = snapshot();
    // 101 goes EOL (not announced); 104 mass -> critical; 105 removed (not announced); 103's generic side identified as Jita; new hole 130.
    after.wormholes = after.wormholes.filter((w) => w.id !== 105);
    after.wormholes.find((w) => w.id === 101)!.life = 'critical';
    after.wormholes.find((w) => w.id === 104)!.mass = 'critical';
    after.signatures.find((s) => s.id === 6)!.systemId = JITA;
    after.signatures.push({ ...after.signatures[8]!, id: 30 }, { ...after.signatures[9]!, id: 31 });
    after.wormholes.push({ id: 130, initialId: 30, secondaryId: 31, type: 'H296', parent: 'initial', life: 'stable', mass: 'stable' });

    const events = diffChain(stateOf(before), buildChain(after));
    const kinds = events.map((e) => `${e.kind}:${'c' in e ? e.c.id : e.id}`).sort();
    expect(kinds).toEqual(['connected:130', 'identified:103', 'mass:104'].sort());
  });

  it('does not report mass improving or life going back to stable', () => {
    const before = snapshot();
    before.wormholes.find((w) => w.id === 104)!.mass = 'critical';
    before.wormholes.find((w) => w.id === 102)!.life = 'critical';
    const after = snapshot();
    after.wormholes.find((w) => w.id === 104)!.mass = 'stable';
    after.wormholes.find((w) => w.id === 102)!.life = 'stable';
    expect(diffChain(stateOf(buildChain(before)), buildChain(after))).toEqual([]);
  });
});
