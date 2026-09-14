import { describe, expect, it } from 'vitest';
import { buildChain } from '../src/chain/graph.js';
import { renderSteps } from '../src/chain/render.js';
import { DEFAULT_PREFS, findRoute, shipClassForJumpMass } from '../src/chain/route.js';
import { HOME, JITA, MAURASI, NIYABAINEN, NOW, PERIMETER, snapshot, universe } from './fixtures.js';

const prefs = (over: Partial<typeof DEFAULT_PREFS>) => ({ ...DEFAULT_PREFS, ...over });

describe('findRoute', () => {
  it('mixes holes and gates, shortest takes the lowsec shortcut', () => {
    const chain = buildChain(snapshot());
    const r = findRoute(chain, universe, HOME, MAURASI)!;
    expect(r.jumps).toBe(4);
    expect(r.holes).toBe(2);
    expect(r.gates).toBe(2);
    expect(r.steps.map((s) => s.to)).toEqual([31000002, JITA, NIYABAINEN, MAURASI]);
  });

  it('safer detours through highsec when one exists', () => {
    const chain = buildChain(snapshot());
    const r = findRoute(chain, universe, HOME, MAURASI, prefs({ mode: 'safer' }))!;
    expect(r.jumps).toBe(5);
    expect(r.steps.map((s) => s.to)).not.toContain(NIYABAINEN);
  });

  it('less secure prefers the lowsec leg even when highsec is as short', () => {
    const chain = buildChain(snapshot());
    const r = findRoute(chain, universe, JITA, MAURASI, prefs({ mode: 'less_safe' }))!;
    expect(r.steps.map((s) => s.to)).toEqual([NIYABAINEN, MAURASI]);
  });

  it('skip-EOL removes the only hole to Jita, so Jita becomes unreachable', () => {
    const chain = buildChain(snapshot());
    expect(findRoute(chain, universe, HOME, JITA)).not.toBeNull();
    expect(findRoute(chain, universe, HOME, JITA, prefs({ skipEol: true }))).toBeNull();
  });

  it('respects the avoid list except at the endpoints', () => {
    const chain = buildChain(snapshot());
    const r = findRoute(chain, universe, JITA, MAURASI, prefs({ avoid: new Set([NIYABAINEN]) }))!;
    expect(r.steps.map((s) => s.to)).not.toContain(NIYABAINEN);
    expect(findRoute(chain, universe, JITA, NIYABAINEN, prefs({ avoid: new Set([NIYABAINEN]) }))?.jumps).toBe(1);
  });

  it('filters holes too small for the ship', () => {
    const chain = buildChain(snapshot());
    // C247 and D845 both allow 375m per jump: battleship ok, capital not.
    expect(findRoute(chain, universe, HOME, JITA, prefs({ minShip: 'l' }))).not.toBeNull();
    expect(findRoute(chain, universe, HOME, JITA, prefs({ minShip: 'xl' }))).toBeNull();
    expect(shipClassForJumpMass(5_000_000)).toBe('s');
    expect(shipClassForJumpMass(62_000_000)).toBe('m');
    expect(shipClassForJumpMass(375_000_000)).toBe('l');
    expect(shipClassForJumpMass(1_350_000_000)).toBe('xl');
    expect(shipClassForJumpMass(null)).toBeNull();
  });
});

describe('renderSteps', () => {
  it('folds gate runs into one line and keeps holes separate', () => {
    const chain = buildChain(snapshot());
    const r = findRoute(chain, universe, HOME, MAURASI, prefs({ mode: 'safer' }))!;
    const lines = renderSteps(r, { universe, now: NOW, home: new Set([HOME]) });
    expect(lines).toEqual([
      'J100001 C4 ⌂',
      ' 1. warp SIG-001 C247 → J100002 C3 · land on SIG-002 · 15h 0m',
      ' 2. warp SIG-003 D845 → Jita HS 0.9 · land on SIG-004 · 2h 0m · EOL',
      ' 3. 3 gates via Perimeter → Urlen → Maurasi HS 0.7',
    ]);
  });
});

describe('copy forms', () => {
  it('draws the security strip: dots for pass-through systems, names at decisions', async () => {
    const { routeStrip } = await import('../src/chain/render.js');
    const chain = buildChain(snapshot());
    const r = findRoute(chain, universe, HOME, MAURASI, prefs({ mode: 'safer' }))!;
    expect(routeStrip(r, { universe, now: NOW })).toBe('🟣J100001 🌀 🔵J100002 🌀 🟩Jita 🟩\u2009🟩 🟩Maurasi');
    const one = findRoute(chain, universe, JITA, PERIMETER)!;
    expect(routeStrip(one, { universe, now: NOW })).toBe('🟩Jita 🟩Perimeter');
    const detailed = routeStrip(r, { universe, now: NOW }, true);
    expect(detailed).toBe('🟣J100001 🌀SIG-001 15h 0m 🔵J100002 🌀SIG-003 2h 0m EOL 🟩Jita 🟩Perimeter 🟩Urlen 🟩Maurasi');
    const md = routeStrip(findRoute(chain, universe, JITA, MAURASI, prefs({ mode: 'safer' }))!, { universe, now: NOW, md: true, tripwireUrl: 'https://tw.example.com' });
    expect(md).toBe('🟩**[Jita](https://tw.example.com/?system=Jita)** [🟩](https://tw.example.com/?system=Perimeter)\u2009[🟩](https://tw.example.com/?system=Urlen) 🟩**[Maurasi](https://tw.example.com/?system=Maurasi)**');
  });

  it('writes the Short Circuit line with folded gates', async () => {
    const { routeChatLine } = await import('../src/chain/render.js');
    const chain = buildChain(snapshot());
    const r = findRoute(chain, universe, HOME, MAURASI, prefs({ mode: 'safer' }))!;
    expect(routeChatLine(r, universe)).toBe('J100001 [SIG-001] ~~> J100002 [SIG-003] ~~> Jita --> ... --> Maurasi');
    const direct = findRoute(chain, universe, JITA, PERIMETER)!;
    expect(routeChatLine(direct, universe)).toBe('Jita --> Perimeter');
  });
});
