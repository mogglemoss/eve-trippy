import { describe, expect, it } from 'vitest';
import { decodeState, defaultState, encodeState } from '../src/bot/routeUi.js';

describe('route state round-trips through customId', () => {
  it('encodes every flag and the avoid toggle', () => {
    const st = { ...defaultState(31001593, 30002703), mode: 'safer' as const, skipEol: true, skipReduced: true, useAvoid: false, details: true, minShip: 'l' as const };
    const id = encodeState(st);
    expect(id).toBe('rt|31001593|30002703|f|ernd|l');
    expect(decodeState(id)).toEqual(st);
    expect(decodeState(encodeState(defaultState(1, 2)))).toEqual(defaultState(1, 2));
    expect(decodeState('nope')).toBeNull();
  });
});
