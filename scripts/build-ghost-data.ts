/**
 * Emits tools/ghosts-universe.json for the server-side purge: every k-space
 * system ID and every stargate pair, from data/universe.json. Re-run after
 * `npm run universe` on patch days.
 */
import { writeFileSync } from 'node:fs';
import { loadUniverse, isKSpace } from '../src/universe/index.js';

const u = loadUniverse();
const kspace = [...u.systems.values()].filter((s) => isKSpace(s.cls)).map((s) => s.id).sort((a, b) => a - b);
const seen = new Set<string>();
const gates: [number, number][] = [];
for (const [a, list] of u.gates) for (const b of list) {
  const key = a < b ? `${a}-${b}` : `${b}-${a}`;
  if (seen.has(key)) continue;
  seen.add(key);
  gates.push(a < b ? [a, b] : [b, a]);
}
const names: Record<string, string> = {};
for (const id of kspace) names[id] = u.systems.get(id)!.name;
const out = { generatedAt: new Date().toISOString(), source: 'trippy data/universe.json', kspace, gates, names };
writeFileSync('tools/ghosts-universe.json', JSON.stringify(out));
console.log(`tools/ghosts-universe.json: ${kspace.length} k-space systems, ${gates.length} stargates`);
