import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { alertKindOf, buildAlertEmbeds, filterAlertEvents } from '../src/bot/alerts.js';
import { ALERT_DEFAULTS, ALERT_KINDS, PrefsStore } from '../src/bot/prefs.js';
import type { ChainEvent } from '../src/chain/diff.js';
import { buildChain } from '../src/chain/graph.js';
import type { RenderOpts } from '../src/chain/render.js';
import { HOME, JITA, NOW, snapshot, universe } from './fixtures.js';

const chain = buildChain(snapshot());
const opts: RenderOpts = { universe, now: NOW, home: new Set([HOME]), md: true, tripwireUrl: 'https://tw.example.com' };
const conn = (id: number) => chain.connections.get(id)!;
const events: ChainEvent[] = [
  { kind: 'connected', c: conn(101) }, // J100001 ⇄ J100002
  { kind: 'connected', c: conn(102) }, // J100002 ⇄ Jita
  { kind: 'identified', c: conn(104), from: { a: null, b: null, sigA: null, sigB: null, type: null, life: 'stable', mass: 'stable' } },
  { kind: 'mass', c: conn(104), from: 'stable' }, // destab
  { kind: 'mass', c: conn(102), from: 'destab' }, // critical? no: fixture 102 is life critical, mass stable
  { kind: 'ghost', c: conn(101) },
];

describe('alert toggles', () => {
  it('each chain event maps to one kind', () => {
    expect(events.map((e) => alertKindOf(e, opts))).toEqual(['connection', 'exit', 'identified', 'heavy', 'heavy', 'ghost']);
    expect(alertKindOf({ kind: 'mass', c: { ...conn(104), mass: 'critical' }, from: 'destab' }, opts)).toBe('spent');
  });

  it('the defaults keep the quiet kinds off', () => {
    const p = new PrefsStore(join(mkdtempSync(join(tmpdir(), 'trippy-')), 'prefs.json'));
    expect(p.alerts()).toEqual(ALERT_DEFAULTS);
    expect(p.alertOn('connection')).toBe(false);
    expect(p.alertOn('identified')).toBe(false);
    expect(p.alertOn('spent')).toBe(false);
    for (const k of ['exit', 'heavy'] as const) expect(p.alertOn(k)).toBe(false);
    for (const k of ['ghost', 'wanted', 'kills'] as const) expect(p.alertOn(k)).toBe(true);
  });

  it('a switch persists across a reload and leaves the others alone', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'trippy-')), 'prefs.json');
    const p = new PrefsStore(path);
    expect(p.setAlert('connection', true)).toBe(true);
    p.setAlert('kills', false);
    const again = new PrefsStore(path);
    expect(again.alertOn('connection')).toBe(true);
    expect(again.alertOn('kills')).toBe(false);
    expect(again.alertOn('exit')).toBe(false);
    expect(ALERT_KINDS.length).toBe(8);
  });

  it('filters events by their kind', () => {
    const kept = filterAlertEvents(events, ALERT_DEFAULTS, opts);
    expect(kept.map((e) => alertKindOf(e, opts))).toEqual(['ghost']);
    const none = filterAlertEvents(events, { ...ALERT_DEFAULTS, ghost: false }, opts);
    expect(none).toEqual([]);
  });

  it('a new hole near a watched place posts with the defaults, where every new-hole kind is off', () => {
    expect(filterAlertEvents(events.slice(0, 2), ALERT_DEFAULTS, opts, [])).toEqual([]);
    const kept = filterAlertEvents(events.slice(0, 2), ALERT_DEFAULTS, opts, [{ systemId: JITA, region: null, gates: 2 }]);
    expect(kept.map((e) => e.c.id)).toEqual([102]);
  });

  it('a lone new exit is titled as one', () => {
    const [e] = buildAlertEmbeds([events[1]!], chain, opts, 'Tripwire');
    expect(e!.toJSON().title).toBe('New exit');
    const [c] = buildAlertEmbeds([events[0]!], chain, opts, 'Tripwire');
    expect(c!.toJSON().title).toBe('New connection');
    const [both] = buildAlertEmbeds(events.slice(0, 2), chain, opts, 'Tripwire');
    expect(both!.toJSON().title).toBe('2 new connections');
  });
});
