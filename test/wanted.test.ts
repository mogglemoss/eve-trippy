import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildWantedEmbed } from '../src/bot/alerts.js';
import { PrefsStore } from '../src/bot/prefs.js';
import { buildChain } from '../src/chain/graph.js';
import { C3, HOME, JITA, NOW, snapshot, universe } from './fixtures.js';

const fresh = () => new PrefsStore(join(mkdtempSync(join(tmpdir(), 'trippy-')), 'prefs.json'));

describe('wanted list', () => {
  it('fires on the off→on edge only, and remembers who asked', () => {
    const p = fresh();
    expect(p.addWanted('g', C3, 'u1', false)).toBe(true);
    expect(p.addWanted('g', C3, 'u2', false)).toBe(false);
    expect(p.get('g').wanted[0]!.userIds).toEqual(['u1', 'u2']);

    expect(p.markWanted(new Set([JITA]))).toEqual([]); // not there yet
    const appeared = p.markWanted(new Set([JITA, C3]));
    expect(appeared.map((a) => a.w.systemId)).toEqual([C3]);
    expect(p.markWanted(new Set([JITA, C3]))).toEqual([]); // still there: no repeat
    expect(p.markWanted(new Set([JITA]))).toEqual([]); // gone: quiet
    expect(p.markWanted(new Set([C3])).length).toBe(1); // back: fires again
  });

  it('a system already on the map when added does not fire until it leaves and returns', () => {
    const p = fresh();
    p.addWanted('g', C3, 'u1', true);
    expect(p.markWanted(new Set([C3]))).toEqual([]);
    p.markWanted(new Set());
    expect(p.markWanted(new Set([C3])).length).toBe(1);
  });

  it('remove drops the entry', () => {
    const p = fresh();
    p.addWanted('g', C3, 'u1', false);
    expect(p.removeWanted('g', C3)).toBe(true);
    expect(p.removeWanted('g', C3)).toBe(false);
    expect(p.get('g').wanted).toEqual([]);
  });

  it('the alert names the system, its connections, hops from home and the askers', () => {
    const chain = buildChain(snapshot());
    const e = buildWantedEmbed(C3, ['u1', 'u2'], chain, { universe, now: NOW, home: new Set([HOME]), md: true, tripwireUrl: 'https://tw.example.com' }, [HOME]).toJSON();
    expect(e.title).toBe('🎯 Wanted: J100002 is on the map');
    expect(e.description).toContain('1 hop from home');
    expect(e.description).toContain('SIG-002');
    expect(e.description).toContain('<@u1>, <@u2>');
  });
});
