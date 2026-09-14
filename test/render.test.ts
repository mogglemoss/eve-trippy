import { describe, expect, it } from 'vitest';
import { buildChain, shortestPath, spanningTree } from '../src/chain/graph.js';
import { INDENT, codeBlocks, connectionSummary, fmtSig, renderRoute, renderSigs, renderTree, systemLabel, timeLeft } from '../src/chain/render.js';
import { HOME, JITA, NOW, snapshot, universe } from './fixtures.js';

const opts = { universe, now: NOW, home: new Set([HOME]) };

describe('helpers', () => {
  it('formats signature ids and time left', () => {
    expect(fmtSig('ABC123')).toBe('ABC-123');
    expect(fmtSig(null)).toBe('???');
    expect(timeLeft(new Date(NOW.getTime() + 90 * 60_000), NOW)).toBe('1h 30m');
    expect(timeLeft(new Date(NOW.getTime() + 26 * 3600_000), NOW)).toBe('1d 2h');
    expect(timeLeft(new Date(NOW.getTime() - 1), NOW)).toBe('past due');
    expect(timeLeft(null, NOW)).toBe('—');
  });

  it('splits long output into Discord-sized code blocks', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(40)}`);
    const blocks = codeBlocks(lines);
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) {
      expect(b.length).toBeLessThanOrEqual(2000);
      expect(b.startsWith('```\n') && b.endsWith('\n```')).toBe(true);
    }
    expect(blocks.join('\n').split('\n').filter((l) => l.startsWith('line ')).length).toBe(200);
  });
});

describe('renderTree', () => {
  it('draws the chain from home with glyphs, badges and flags', () => {
    const chain = buildChain(snapshot());
    const text = renderTree(spanningTree(chain, HOME), opts).join('\n');
    expect(text).toMatchInlineSnapshot(`
      "⌂ J100001 C4 · Wolf-Rayet Star · statics C247/X877 · D-R00019
      ├─ SIG-001 C247 → J100002 C3 · 15h 0m
      │  ├─ SIG-003 D845 → Jita HS 0.9 · 2h 0m · EOL
      │  └─ SIG-007 K162 → Amarr HS 1.0 · 15h 0m · destab
      └─ SIG-005 ??? → High-Sec · 15h 0m"
    `);
  });
});

describe('renderRoute', () => {
  it('lists each jump with the signature to warp to and the one you arrive at', () => {
    const chain = buildChain(snapshot());
    const lines = renderRoute(shortestPath(chain, HOME, JITA)!, HOME, opts);
    expect(lines).toEqual([
      'J100001 C4 ⌂',
      ' 1. warp SIG-001 C247 → J100002 C3 · land on SIG-002 · 15h 0m',
      ' 2. warp SIG-003 D845 → Jita HS 0.9 · land on SIG-004 · 2h 0m · EOL',
    ]);
  });
});

describe('renderSigs / connectionSummary', () => {
  it('shows wormholes first with their destination, then other sigs', () => {
    const chain = buildChain(snapshot());
    const lines = renderSigs(chain.sigsBySystem.get(HOME)!, HOME, chain, opts);
    expect(lines[0]).toBe('SIG-001 wormhole C247 → J100002 C3 · 15h 0m');
    expect(lines[2]).toBe('SIG-011 relic    Forgotten Frontier Quarantine Outpost · 15h 0m');
  });

  it('summarises both ends for alerts', () => {
    const chain = buildChain(snapshot());
    expect(connectionSummary(chain.connections.get(102)!, opts)).toBe('J100002 C3 SIG-003 ⇄ SIG-004 Jita HS 0.9 [D845] · EOL · 2h 0m');
  });
});

describe('markdown mode', () => {
  const mdOpts = { ...opts, md: true, tripwireUrl: 'https://tw.example.com' };

  it('links systems to Tripwire and pills the class', () => {
    expect(systemLabel(mdOpts, JITA)).toBe('🟩 **[Jita](https://tw.example.com/?system=Jita)** `HS 0.9`');
    expect(systemLabel(mdOpts, HOME)).toBe('🟣 **[J100001](https://tw.example.com/?system=J100001)** `C4` 🏠');
    expect(systemLabel(mdOpts, 2)).toBe('⚪ *High-Sec*');
  });

  it('indents the tree with wide spaces and keeps every line self-contained', () => {
    const chain = buildChain(snapshot());
    const lines = renderTree(spanningTree(chain, HOME), mdOpts);
    expect(lines[0]).toMatch(/^🏠 🟣 \*\*\[J100001\]/);
    expect(lines[1]).toMatch(/^└ \*\*SIG-001\*\* C247 → 🔵 \*\*\[J100002\]/);
    expect(lines[2]!.startsWith(`${INDENT}└ **SIG-003** D845 →`)).toBe(true);
    expect(lines[2]).toContain('⏳ EOL');
    expect(lines[3]).toContain('🟠 destab');
  });

  it('summarises a connection with pills for alerts', () => {
    const chain = buildChain(snapshot());
    expect(connectionSummary(chain.connections.get(102)!, mdOpts)).toContain('`D845` · ⏳ EOL · 2h 0m');
  });
});
