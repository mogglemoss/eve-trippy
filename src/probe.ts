/**
 * Dry run without Discord: reads Tripwire with the configured credentials and
 * prints what the bot would show. `npm run probe [-- <system>]`.
 */
import { buildChain, components, reachable, shortestPath, spanningTree } from './chain/graph.js';
import { connectionSummary, renderExits, renderTree, systemLabel, type Exit, type RenderOpts } from './chain/render.js';
import { loadConfig, loadDotEnv } from './config.js';
import { TripwireClient, TripwireError } from './tripwire/client.js';
import { findSystem, isExit, loadUniverse } from './universe/index.js';

loadDotEnv();
const config = loadConfig(process.env, { requireDiscord: false });
const universe = loadUniverse();
const tripwire = new TripwireClient(config.tripwire);

console.log(`Tripwire ${config.tripwire.url} mask ${config.tripwire.maskId} as ${config.tripwire.username}`);
let chain;
try {
  const t0 = Date.now();
  chain = buildChain(await tripwire.snapshot());
  console.log(`fetched in ${Date.now() - t0} ms: ${chain.signatures.size} signatures, ${chain.connections.size} connections, ${chain.adj.size} systems, ${chain.skipped.length} dangling wormhole rows`);
} catch (e) {
  if (e instanceof TripwireError) {
    console.error(`${e.kind}: ${e.message}`);
    process.exit(1);
  }
  throw e;
}

const arg = process.argv[2];
const homes = config.homeSystems.map((n) => findSystem(universe, n)?.id).filter((id): id is number => typeof id === 'number');
const roots = arg ? [findSystem(universe, arg)?.id].filter((id): id is number => typeof id === 'number') : homes.length ? homes : components(chain)[0]?.slice(0, 1) ?? [];
const opts: RenderOpts = { universe, now: new Date(), home: new Set(homes) };

for (const root of roots) {
  console.log();
  console.log(renderTree(spanningTree(chain, root), opts).join('\n'));
  const exits: Exit[] = [];
  for (const id of reachable(chain, root)) {
    const s = universe.systems.get(id);
    if (!s || !isExit(s.cls) || id === root) continue;
    const path = shortestPath(chain, root, id);
    if (path) exits.push({ system: s, path });
  }
  exits.sort((x, y) => x.path.length - y.path.length);
  if (exits.length) {
    console.log();
    console.log(`Exits from ${systemLabel(opts, root)}:`);
    console.log(renderExits(exits, root, opts).map((l) => `  ${l}`).join('\n'));
  }
}

const flagged = [...chain.connections.values()].filter((c) => c.life === 'critical' || c.mass !== 'stable');
if (flagged.length) {
  console.log();
  console.log('EOL / mass-reduced:');
  for (const c of flagged) console.log(`  ${connectionSummary(c, opts)}`);
}
const groups = components(chain);
if (groups.length > 1) console.log(`\n${groups.length} fragments on the map: ${groups.map((g) => g.length).join(', ')} systems`);
