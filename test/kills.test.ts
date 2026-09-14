import { describe, expect, it } from 'vitest';
import { R2z2, toKill, type R2z2File } from '../src/kills/r2z2.js';
import { buildKillEmbed, fmtIsk, sideOf, type KillContext } from '../src/bot/kills.js';
import { buildChain } from '../src/chain/graph.js';
import type { Esi } from '../src/esi.js';
import { C3, NOW, snapshot, universe } from './fixtures.js';

function file(seq: number, over: Partial<R2z2File['esi']> = {}, minutesAgo = 1): R2z2File {
  return {
    killmail_id: 1_000_000 + seq,
    hash: 'h',
    esi: {
      killmail_id: 1_000_000 + seq,
      killmail_time: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      solar_system_id: 31001593,
      victim: { character_id: 1, corporation_id: 98000001, ship_type_id: 587 },
      attackers: [{ character_id: 2, corporation_id: 555, ship_type_id: 17709, final_blow: true }, { character_id: 3, corporation_id: 555 }],
      ...over,
    },
    zkb: { totalValue: 34_365_701, npc: false, solo: false, awox: false, labels: [], attackerCount: 2 },
    uploaded_at: 0,
    sequence_id: seq,
  };
}

/** A fake feed: `present` maps sequence -> file; sequence.json reports `head`. */
function fakeFeed(present: Map<number, R2z2File>, head: () => number): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/sequence.json')) return new Response(JSON.stringify({ sequence: head() }), { status: 200 });
    const seq = Number(/\/(\d+)\.json$/.exec(url)?.[1]);
    const f = present.get(seq);
    return f ? new Response(JSON.stringify(f), { status: 200 }) : new Response('', { status: 404 });
  }) as typeof fetch;
}

describe('toKill', () => {
  it('reduces an R2Z2 file to what we announce', () => {
    const k = toKill(file(7));
    expect(k).toMatchObject({ id: 1_000_007, systemId: 31001593, attackers: 2, totalValue: 34_365_701 });
    expect(k.victim.corporationId).toBe(98000001);
    expect(k.finalBlow?.shipTypeId).toBe(17709);
    expect([...k.attackerCorps]).toEqual([555]);
  });
});

describe('R2z2.run', () => {
  it('starts at the head, walks forward, skips holes, drops stale mails, and can resume', async () => {
    const present = new Map<number, R2z2File>();
    let head = 100;
    const feed = fakeFeed(present, () => head);
    let clock = Date.now();
    const seen: number[] = [];
    const r = new R2z2({
      fetchImpl: feed, idleMs: 1000, stepMs: 0, holePatienceMs: 5000, resyncMs: 60_000, maxAgeMs: 10 * 60_000,
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
    });
    // Files appear over time: 101, then a hole at 102, 103 exists, 104 is a stale reprocessed mail.
    present.set(101, file(101));
    present.set(103, file(103));
    present.set(104, file(104, {}, 30));
    const run = r.run((k, seq) => { seen.push(seq); if (seen.length === 2) r.stop(); }, null);
    await run;
    expect(seen).toEqual([101, 103]); // 102 was a hole, skipped after patience ran out
    expect(r.skipped).toBe(1);
    expect(r.next).toBe(104);

    // Resume from a saved cursor: 104 is stale (not announced) but consumed.
    const seen2: number[] = [];
    const r2 = new R2z2({ fetchImpl: feed, idleMs: 1000, stepMs: 0, sleep: async (ms) => { clock += ms; }, now: () => clock });
    present.set(105, file(105));
    await r2.run((k, seq) => { seen2.push(seq); r2.stop(); }, 104);
    expect(seen2).toEqual([105]);
    expect(r2.stale).toBe(1);
  });

  it('jumps to the head when a saved cursor is hopelessly old', async () => {
    const present = new Map<number, R2z2File>();
    const feed = fakeFeed(present, () => 50_000);
    let clock = Date.now();
    present.set(50_001, file(50_001));
    const r = new R2z2({ fetchImpl: feed, idleMs: 1000, stepMs: 0, sleep: async (ms) => { clock += ms; }, now: () => clock });
    const seen: number[] = [];
    await r.run((k, seq) => { seen.push(seq); r.stop(); }, 10);
    expect(seen).toEqual([50_001]);
  });
});

describe('sideOf / fmtIsk', () => {
  const ctx = { friendlyCorps: new Set([98000001]), friendlyAlliances: new Set([99000001]) } as unknown as KillContext;
  it('tells a loss from a kill from a neutral', () => {
    expect(sideOf(toKill(file(1)), ctx)).toBe('loss');
    expect(sideOf(toKill(file(2, { victim: { corporation_id: 1 }, attackers: [{ corporation_id: 98000001, final_blow: true }] })), ctx)).toBe('kill');
    expect(sideOf(toKill(file(3, { victim: { corporation_id: 1 }, attackers: [{ alliance_id: 99000001, final_blow: true }] })), ctx)).toBe('kill');
    expect(sideOf(toKill(file(4, { victim: { corporation_id: 1 }, attackers: [{ corporation_id: 2, final_blow: true }] })), ctx)).toBe('neutral');
  });
  it('formats ISK the way pilots say it', () => {
    expect(fmtIsk(34_365_701)).toBe('34.4m');
    expect(fmtIsk(255_881_940)).toBe('256m');
    expect(fmtIsk(2_400_000_000)).toBe('2.4b');
    expect(fmtIsk(12_000)).toBe('12k');
  });
});

describe('buildKillEmbed', () => {
  const esi = { resolveNames: async () => new Map(), name: (_id: number, fb = 'unknown') => fb, corp: async () => null, alliance: async () => null } as unknown as Esi;

  it('names who scanned each hole into the system, oldest first, with no home configured', async () => {
    const snap = snapshot();
    const wayIn = snap.signatures.find((s) => s.id === 2)!; // J100002's side of the hole from J100001
    wayIn.createdBy = 'Legendary Sushi';
    wayIn.createdAt = new Date(NOW.getTime() - 3 * 3600_000);
    const chain = buildChain(snap);
    const ctx: KillContext = {
      chain, esi, homes: [], friendlyCorps: new Set(), friendlyAlliances: new Set(), avatarUrl: null,
      opts: { universe, now: NOW, home: new Set(), md: true, tripwireUrl: 'https://tw.example.com' },
    };
    const k = toKill(file(9, { solar_system_id: C3 }));
    const e = (await buildKillEmbed(k, ctx)).toJSON();
    expect(e.title).toBe('💥 Rifter down in J100002');
    expect(e.description).toMatch(/lost a \*\*Rifter\*\* worth \*\*34\.4m\*\* ISK to a gang of 2/);
    const wayIn = e.fields!.find((f) => f.name.startsWith('Way'))!;
    expect(wayIn.name).toBe('Ways in');
    const rows = wayIn.value.split('\n');
    expect(rows).toHaveLength(3);
    // Oldest first: the way in is the first line.
    expect(rows[0]).toMatch(/^SIG-002 from .*J100001.* SIG-001 · scanned by \*\*Legendary Sushi\*\* 3h ago$/);
    expect(rows[0]).toContain('**[J100001](https://tw.example.com/?system=J100001)**');
    expect(rows[1]).toMatch(/scanned by \*\*Scanner One\*\*/);
    expect(e.fields!.find((f) => f.name === 'Way out')!.value).toMatch(/^1 hop: .*J100002.* → .*Jita/);
    expect(e.fields!.find((f) => f.name === 'Where')!.value).toContain('[zKill](https://zkillboard.com/system/31000002/)');
    expect(e.fields!.some((f) => f.name.startsWith('Gang · 2 pilots'))).toBe(true);
  });

  it('says nothing about scouts for a system with no mapped holes', async () => {
    const ctx: KillContext = {
      chain: buildChain(snapshot()), esi, homes: [], friendlyCorps: new Set(), friendlyAlliances: new Set(), avatarUrl: null,
      opts: { universe, now: NOW, home: new Set(), md: true, tripwireUrl: 'https://tw.example.com' },
    };
    const e = (await buildKillEmbed(toKill(file(10, { solar_system_id: 31000005 })), ctx)).toJSON();
    expect(e.fields!.some((f) => f.name.startsWith('Chain scout'))).toBe(false);
  });
});
