import { describe, expect, it } from 'vitest';
import { TripwireClient, TripwireError, normaliseSignature, normaliseWormhole, parseApiBody, parseTripwireDate } from '../src/tripwire/client.js';

describe('parseApiBody', () => {
  it('maps Tripwire status codes and text-prefixed errors', () => {
    expect(() => parseApiBody(401, 'Authentication failed')).toThrow(TripwireError);
    expect(() => parseApiBody(503, '')).toThrowError(/switched off/);
    expect(() => parseApiBody(200, 'Mask ID is requirednull')).toThrowError(/Mask ID is required/);
    expect(() => parseApiBody(200, 'You are not authorized to use this masknull')).toThrowError(/not authorized/);
    expect(() => parseApiBody(400, 'MaskID must be a decimal')).toThrowError(/decimal/);
    expect(() => parseApiBody(200, '<html>login</html>')).toThrowError(/Unexpected/);
  });

  it('treats null as an empty result set', () => {
    expect(parseApiBody(200, 'null')).toEqual([]);
    expect(parseApiBody(200, '[{"id":"1"}]')).toEqual([{ id: '1' }]);
  });
});

describe('parseTripwireDate', () => {
  it('reads Y-m-d H:i:s e', () => {
    expect(parseTripwireDate('2026-09-07 12:00:00 UTC').toISOString()).toBe('2026-09-07T12:00:00.000Z');
    expect(parseTripwireDate('2026-09-07 12:00:00').toISOString()).toBe('2026-09-07T12:00:00.000Z');
    expect(parseTripwireDate('2026-07-01 13:00:00 Europe/London').toISOString()).toBe('2026-07-01T12:00:00.000Z');
    expect(parseTripwireDate('2026-07-01 13:00:00 +02:00').toISOString()).toBe('2026-07-01T11:00:00.000Z');
  });
});

describe('normalise', () => {
  it('turns PDO strings into typed rows', () => {
    const s = normaliseSignature({
      id: '42', signatureID: 'abc-123', systemID: '31000001', type: 'wormhole', name: '', bookmark: null,
      lifeTime: '2026-09-07 10:00:00 UTC', lifeLeft: '2026-09-08 02:00:00 UTC', lifeLength: '57600',
      createdByName: 'Scanner One', modifiedByName: 'Scanner One', modifiedTime: '2026-09-07 10:30:00 UTC',
    });
    expect(s).toMatchObject({ id: 42, sigId: 'ABC123', systemId: 31000001, type: 'wormhole', name: null, lifeLengthSec: 57600 });
    expect(s.expiresAt.toISOString()).toBe('2026-09-08T02:00:00.000Z');
    expect(normaliseSignature({ id: 1, signatureID: '???', systemID: null, type: 'bogus', lifeTime: 'x', lifeLeft: 'x', lifeLength: 0, modifiedTime: 'x' }))
      .toMatchObject({ sigId: null, systemId: null, type: 'unknown' });
    expect(normaliseWormhole({ id: '7', initialID: '1', secondaryID: '2', type: 'c247', parent: 'Initial', life: 'critical', mass: 'destab' }))
      .toEqual({ id: 7, initialId: 1, secondaryId: 2, type: 'C247', parent: 'initial', life: 'critical', mass: 'destab' });
  });
});

describe('TripwireClient', () => {
  it('builds the api.php URL and sends Basic auth', async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      seen = { url: String(input), auth: headers.get('authorization') };
      return new Response('[{"id":"1","initialID":"1","secondaryID":"2","life":"stable","mass":"stable"}]', { status: 200 });
    };
    const client = new TripwireClient({ url: 'https://tw.example.com/', username: 'u', password: 'p', maskId: '98000001.2', fetchImpl });
    const rows = await client.wormholes();
    expect(rows).toHaveLength(1);
    expect(seen!.url).toBe('https://tw.example.com/api.php?q=%2Fwormholes&maskID=98000001.2');
    expect(seen!.auth).toBe('Basic ' + Buffer.from('u:p').toString('base64'));
  });
});
