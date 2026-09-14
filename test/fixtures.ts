import type { Signature, Snapshot, Wormhole } from '../src/tripwire/types.js';
import { universeFrom, type HoleType, type SystemInfo } from '../src/universe/index.js';

export const NOW = new Date('2026-09-07T12:00:00Z');

export const HOME = 31000001; // J100001 C4
export const C3 = 31000002; // J100002 C3
export const JITA = 30000142;
export const C5A = 31000003; // J100003 (detached fragment)
export const C5B = 31000004; // J100004
export const AMARR = 30002187;
// A little k-space: Jita -(Perimeter, HS)-> Urlen(HS) -> Maurasi(HS) ; Jita -> Niyabainen(LS) -> Maurasi (shortcut through lowsec)
export const PERIMETER = 30000144;
export const URLEN = 30000138;
export const MAURASI = 30000140;
export const NIYABAINEN = 30000145;

const sys = (id: number, name: string, cls: SystemInfo['cls'], extra: Partial<SystemInfo> = {}): SystemInfo => ({
  id, name, cls, sec: null, region: 'D-R00019', effect: null, statics: [], shattered: false, ...extra,
});

export const universe = universeFrom(
  [
    sys(HOME, 'J100001', 'c4', { effect: 'Wolf-Rayet Star', statics: ['C247', 'X877'] }),
    sys(C3, 'J100002', 'c3', { statics: ['D845'] }),
    sys(JITA, 'Jita', 'hs', { sec: 0.946, region: 'The Forge' }),
    sys(AMARR, 'Amarr', 'hs', { sec: 1.0, region: 'Domain' }),
    sys(C5A, 'J100003', 'c5'),
    sys(C5B, 'J100004', 'c5'),
    sys(31000005, 'Thera', 'thera', { region: 'G-R00031' }),
    sys(PERIMETER, 'Perimeter', 'hs', { sec: 0.9, region: 'The Forge' }),
    sys(URLEN, 'Urlen', 'hs', { sec: 0.9, region: 'The Forge' }),
    sys(MAURASI, 'Maurasi', 'hs', { sec: 0.7, region: 'The Forge' }),
    sys(NIYABAINEN, 'Niyabainen', 'ls', { sec: 0.4, region: 'The Forge' }),
  ],
  [
    { code: 'C247', dest: 'c3', src: ['c4'], isStatic: true, totalMass: 2e9, jumpMass: 375e6, lifetimeHours: 16, massRegen: 0 },
    { code: 'D845', dest: 'hs', src: ['c3'], isStatic: true, totalMass: 5e9, jumpMass: 375e6, lifetimeHours: 24, massRegen: 0 },
    { code: 'K162', dest: null, src: [], isStatic: false, totalMass: null, jumpMass: null, lifetimeHours: null, massRegen: null },
  ] satisfies HoleType[],
  { c4: 'Class 4' },
  '2026-09-07T00:00:00Z',
  [[JITA, PERIMETER], [PERIMETER, URLEN], [URLEN, MAURASI], [JITA, NIYABAINEN], [NIYABAINEN, MAURASI]],
);

let nextId = 1;

export function sig(partial: Partial<Signature> & { systemId: number | null }): Signature {
  const id = partial.id ?? nextId++;
  const createdAt = partial.createdAt ?? new Date(NOW.getTime() - 3600_000);
  return {
    id,
    sigId: `SIG${String(id).padStart(3, '0')}`,
    type: 'wormhole',
    name: null,
    bookmark: null,
    createdAt,
    expiresAt: partial.expiresAt ?? new Date(createdAt.getTime() + 16 * 3600_000),
    lifeLengthSec: 16 * 3600,
    createdBy: 'Scanner One',
    modifiedBy: 'Scanner One',
    modifiedAt: createdAt,
    ...partial,
  };
}

export function wh(partial: Partial<Wormhole> & { initialId: number; secondaryId: number }): Wormhole {
  return { id: partial.id ?? nextId++, type: null, parent: 'initial', life: 'stable', mass: 'stable', ...partial };
}

/**
 * The reference map:
 *   J100001 (home, C4) --C247--> J100002 (C3) --D845--> Jita
 *                     \--???--> High-Sec (generic 2)
 *   J100002 --K162 (unknown type)--> Amarr, parent on the Amarr side
 *   J100003 <-> J100004 detached fragment
 */
export function snapshot(): Snapshot & { ids: Record<string, number> } {
  nextId = 1;
  const homeToC3 = sig({ id: 1, systemId: HOME });
  const c3FromHome = sig({ id: 2, systemId: C3 });
  const c3ToJita = sig({ id: 3, systemId: C3, expiresAt: new Date(NOW.getTime() + 2 * 3600_000) });
  const jitaFromC3 = sig({ id: 4, systemId: JITA });
  const homeToHs = sig({ id: 5, systemId: HOME });
  const genericHs = sig({ id: 6, systemId: 2, sigId: null, lifeLengthSec: 0 });
  const c3ToAmarr = sig({ id: 7, systemId: C3 });
  const amarrFromC3 = sig({ id: 8, systemId: AMARR });
  const a = sig({ id: 9, systemId: C5A });
  const b = sig({ id: 10, systemId: C5B });
  const relic = sig({ id: 11, systemId: HOME, type: 'relic', name: 'Forgotten Frontier Quarantine Outpost' });
  const wormholes = [
    wh({ id: 101, initialId: 1, secondaryId: 2, type: 'C247', parent: 'initial' }),
    wh({ id: 102, initialId: 3, secondaryId: 4, type: 'D845', parent: 'initial', life: 'critical' }),
    wh({ id: 103, initialId: 5, secondaryId: 6, type: null, parent: null }),
    wh({ id: 104, initialId: 7, secondaryId: 8, type: 'K162', parent: 'secondary', mass: 'destab' }),
    wh({ id: 105, initialId: 9, secondaryId: 10, type: 'H296', parent: 'initial' }),
    wh({ id: 106, initialId: 9, secondaryId: 999, type: 'X', parent: 'initial' }), // dangling
  ];
  return {
    signatures: [homeToC3, c3FromHome, c3ToJita, jitaFromC3, homeToHs, genericHs, c3ToAmarr, amarrFromC3, a, b, relic],
    wormholes,
    fetchedAt: NOW,
    ids: { homeToC3: 101, c3ToJita: 102, homeToHs: 103, c3ToAmarr: 104, fragment: 105 },
  };
}
