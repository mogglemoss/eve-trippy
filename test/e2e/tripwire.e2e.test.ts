/**
 * Live: reads the Tripwire in .env (dev by default) and checks the whole
 * read path on real rows. Opt in with TRIPPY_E2E=1; needs a .env.
 */
import { describe, expect, it } from 'vitest';
import { buildChain } from '../../src/chain/graph.js';
import { loadConfig, loadDotEnv } from '../../src/config.js';
import { TripwireClient } from '../../src/tripwire/client.js';
import { loadUniverse } from '../../src/universe/index.js';

const live = process.env.TRIPPY_E2E === '1';

describe.skipIf(!live)('live Tripwire', () => {
  loadDotEnv();
  const config = loadConfig(process.env, { requireDiscord: false });
  const tw = new TripwireClient(config.tripwire);
  const u = loadUniverse();

  it('authenticates and returns rows the chain builder understands', async () => {
    const snap = await tw.snapshot();
    expect(snap.signatures.length).toBeGreaterThan(0);
    for (const s of snap.signatures) {
      expect(Number.isFinite(s.id)).toBe(true);
      expect(s.expiresAt.getTime()).not.toBeNaN();
    }
    const chain = buildChain(snap);
    expect(chain.connections.size).toBeGreaterThan(0);
    expect(chain.skipped.length, 'dangling wormhole rows').toBe(0);
    for (const id of chain.adj.keys()) expect(u.systems.has(id), `system ${id} unknown to the universe`).toBe(true);
  });

  it('reads comments for a system on the map and for the whole mask', async () => {
    const snap = await tw.snapshot();
    const chain = buildChain(snap);
    const all = await tw.comments();
    expect(Array.isArray(all)).toBe(true);
    const first = [...chain.adj.keys()][0]!;
    const some = await tw.comments(first);
    for (const c of some) expect(c.systemId).toBe(first);
  });

  it('refuses a wrong password with a clear error', async () => {
    const bad = new TripwireClient({ ...config.tripwire, password: 'definitely-not-it' });
    await expect(bad.wormholes()).rejects.toThrow(/username\/password/);
  });
});
