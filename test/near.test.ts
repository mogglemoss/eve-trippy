import { describe, expect, it } from 'vitest';
import { buildChain } from '../src/chain/graph.js';
import { gateDistance, ghostReport, ghosts, isGhost } from '../src/chain/ghosts.js';
import { nearestMapped, proximities } from '../src/chain/near.js';
import { findRoute, DEFAULT_PREFS, scoutBlocked } from '../src/chain/route.js';
import { universeFrom } from '../src/universe/index.js';
import type { ScoutHole } from '../src/scout.js';
import { AMARR, HOME, JITA, MAURASI, NIYABAINEN, PERIMETER, URLEN, sig, snapshot, universe, wh } from './fixtures.js';

describe('nearestMapped', () => {
  it('finds mapped systems by gate distance across fragments', () => {
    const chain = buildChain(snapshot());
    // Jita and Amarr are mapped; Maurasi is 2 gates from Jita via Niyabainen (lowsec) or 3 via Perimeter/Urlen.
    const near = nearestMapped(chain, universe, MAURASI, 5, 10);
    expect(near[0]).toMatchObject({ system: JITA, gates: 2 });
    expect(near[0]!.path).toEqual([NIYABAINEN, JITA]);
    expect(near[0]!.fragmentSize).toBe(4);
  });
  it('reports a mapped origin at zero gates', () => {
    const chain = buildChain(snapshot());
    expect(nearestMapped(chain, universe, JITA, 1)[0]).toMatchObject({ system: JITA, gates: 0 });
  });
});

describe('proximities', () => {
  it('matches watched systems within N gates and watched regions', () => {
    const p = proximities(universe, URLEN, [
      { systemId: JITA, region: null, gates: 5 },
      { systemId: MAURASI, region: null, gates: 0 },
      { systemId: null, region: 'The Forge', gates: 0 },
      { systemId: null, region: 'Domain', gates: 0 },
    ]);
    expect(p).toEqual([
      { exit: URLEN, gates: 2, systemId: JITA, region: null },
      { exit: URLEN, gates: 0, systemId: null, region: 'The Forge' },
    ]);
  });
});

describe('ghosts', () => {
  it('flags k-space↔k-space holes with no sig ids and no type', () => {
    const snap = snapshot();
    snap.signatures.push(sig({ id: 40, systemId: JITA, sigId: null }), sig({ id: 41, systemId: PERIMETER, sigId: null }));
    snap.wormholes.push(wh({ id: 140, initialId: 40, secondaryId: 41, type: null, parent: null }));
    // a real k-space↔k-space hole with sig ids is not a ghost
    snap.signatures.push(sig({ id: 42, systemId: JITA }), sig({ id: 43, systemId: AMARR }));
    snap.wormholes.push(wh({ id: 141, initialId: 42, secondaryId: 43, type: 'B274' }));
    // no ids, no type, but Jita and Amarr share no gates in the fixture: unidentified, not a ghost
    snap.signatures.push(sig({ id: 44, systemId: JITA, sigId: null }), sig({ id: 45, systemId: AMARR, sigId: null }));
    snap.wormholes.push(wh({ id: 142, initialId: 44, secondaryId: 45, type: null, parent: null }));
    const chain = buildChain(snap);
    expect(isGhost(chain.connections.get(140)!, universe)).toBe(true); // Jita ↔ Perimeter, 1 gate
    expect(isGhost(chain.connections.get(141)!, universe)).toBe(false); // has sig ids
    expect(isGhost(chain.connections.get(101)!, universe)).toBe(false); // J-space end
    expect(isGhost(chain.connections.get(142)!, universe)).toBe(false); // too far by gate
    expect(ghosts(chain, universe).map((c) => c.id)).toEqual([140]);
    expect(ghostReport(chain, universe).unidentified.map((c) => c.id)).toEqual([142]);
    expect(gateDistance(universe, JITA, MAURASI, 3)).toBe(2);
    expect(gateDistance(universe, JITA, AMARR, 3)).toBeNull();
    expect(gateDistance(universe, JITA, JITA, 3)).toBe(0);
  });
});

describe('EVE-Scout routing', () => {
  const thera = 31000005;
  const hole: ScoutHole = {
    id: '1', hubId: thera, hubName: 'Thera', hubSignature: 'ABC-123', outId: AMARR, outName: 'Amarr', outSignature: 'DEF-456',
    type: 'Q063', maxShipSize: 'large', remainingHours: 12, expiresAt: null, updatedAt: null,
  };
  const hole2: ScoutHole = { ...hole, id: '2', outId: MAURASI, outName: 'Maurasi', outSignature: 'GHI-789' };

  it('uses Thera as a shortcut when scout holes are supplied', () => {
    const chain = buildChain(snapshot());
    // Without scout: Maurasi → Jita by gate, then two holes through J100002 to Amarr.
    expect(findRoute(chain, universe, MAURASI, AMARR)!.jumps).toBe(4);
    const r = findRoute(chain, universe, MAURASI, AMARR, { ...DEFAULT_PREFS, scout: [hole, hole2] })!;
    expect(r.steps.map((s) => s.kind)).toEqual(['scout', 'scout']);
    expect(r.steps.map((s) => s.to)).toEqual([thera, AMARR]);
    expect(r.holes).toBe(2);
  });

  it('filters scout holes by ship size and EOL', () => {
    expect(scoutBlocked(hole, { ...DEFAULT_PREFS, minShip: 'xl' })).toMatch(/too small/);
    expect(scoutBlocked(hole, { ...DEFAULT_PREFS, minShip: 'l' })).toBeNull();
    expect(scoutBlocked({ ...hole, remainingHours: 2 }, { ...DEFAULT_PREFS, skipEol: true })).toBe('EOL');
  });
});

describe('heap routing at scale', () => {
  it('stays fast when the frontier is large', () => {
    // A 60x60 grid of highsec systems with one route across it.
    const systems = [];
    const gates: [number, number][] = [];
    const id = (x: number, y: number) => 40_000_000 + x * 100 + y;
    for (let x = 0; x < 60; x++) for (let y = 0; y < 60; y++) {
      systems.push({ id: id(x, y), name: `G${x}-${y}`, cls: 'hs' as const, sec: 0.9, region: 'Grid', effect: null, statics: [], shattered: false });
      if (x) gates.push([id(x - 1, y), id(x, y)]);
      if (y) gates.push([id(x, y - 1), id(x, y)]);
    }
    const u = universeFrom(systems, [], {}, '', gates);
    const chain = buildChain({ signatures: [], wormholes: [], fetchedAt: new Date() });
    const t0 = performance.now();
    const r = findRoute(chain, u, id(0, 0), id(59, 59), { ...DEFAULT_PREFS, mode: 'safer' })!;
    expect(r.jumps).toBe(118);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
