/**
 * Kill alerts: one embed per killmail in a watched system, laid out the way
 * a scout wants to read it — what died, to whom, where that is in the chain,
 * who scouted the hole in, and the nearest way out to k-space.
 */
import { EmbedBuilder } from 'discord.js';
import type { Chain, Connection } from '../chain/graph.js';
import { farSide, farSig, nearSig, shortestPath } from '../chain/graph.js';
import type { Signature } from '../tripwire/types.js';
import { ago, fmtSig, nameLink, systemLabel, type RenderOpts } from '../chain/render.js';
import type { Esi } from '../esi.js';
import type { Kill } from '../kills/types.js';
import { isExit, isRealSystemId } from '../universe/index.js';
import { AUTHOR, COLOUR } from './voice.js';

export function fmtIsk(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1)}b`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e8 ? 0 : 1)}m`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
  return `${Math.round(v)}`;
}

export interface KillContext {
  chain: Chain;
  opts: RenderOpts;
  esi: Esi;
  homes: number[];
  /** Our own corp/alliance IDs, to tell a loss from a kill. */
  friendlyCorps: Set<number>;
  friendlyAlliances: Set<number>;
  avatarUrl: string | null;
}

export type Side = 'loss' | 'kill' | 'neutral';

export function sideOf(k: Kill, ctx: KillContext): Side {
  const victimOurs = (k.victim.corporationId !== null && ctx.friendlyCorps.has(k.victim.corporationId))
    || (k.victim.allianceId !== null && ctx.friendlyAlliances.has(k.victim.allianceId));
  if (victimOurs) return 'loss';
  const attackerOurs = [...k.attackerCorps].some((c) => ctx.friendlyCorps.has(c)) || [...k.attackerAlliances].some((a) => ctx.friendlyAlliances.has(a));
  return attackerOurs ? 'kill' : 'neutral';
}

/** "Pilot · Corp [TICK] <Alliance>" with what we could resolve. */
async function affiliation(ctx: KillContext, characterId: number | null, corporationId: number | null, allianceId: number | null, fallback: string): Promise<string> {
  const pilot = characterId ? ctx.esi.name(characterId, fallback) : fallback;
  const corp = corporationId ? await ctx.esi.corp(corporationId) : null;
  const allianceIdResolved = allianceId ?? corp?.allianceId ?? null;
  const alliance = allianceIdResolved ? await ctx.esi.alliance(allianceIdResolved) : null;
  const bits = [`**${pilot}**`];
  if (corp) bits.push(`${corp.name} [${corp.ticker}]`);
  else if (corporationId) bits.push(ctx.esi.name(corporationId, ''));
  if (alliance) bits.push(`<${alliance.ticker}>`);
  return bits.filter(Boolean).join(' · ');
}

/**
 * The holes into `systemId` with who scanned each, oldest sig first: the first
 * one is how the chain got here, and the scanner is who to ask about it.
 */
export function holesInto(ctx: KillContext, systemId: number): { c: Connection; landing: Signature; entry: Signature; scanner: string }[] {
  return (ctx.chain.adj.get(systemId) ?? [])
    .map((c) => {
      const landing = nearSig(c, systemId);
      const entry = farSig(c, systemId);
      return { c, landing, entry, scanner: landing.createdBy || entry.createdBy || c.createdBy || 'unknown' };
    })
    .sort((x, y) => x.landing.createdAt.getTime() - y.landing.createdAt.getTime());
}

/** Nearest k-space or Thera exit from `systemId` through the chain, with the path. */
function nearestExit(ctx: KillContext, systemId: number): { system: number; path: number[] } | null {
  const u = ctx.opts.universe;
  const seen = new Set<number>([systemId]);
  const prev = new Map<number, number>();
  const queue = [systemId];
  while (queue.length) {
    const sys = queue.shift()!;
    const cls = u.systems.get(sys)?.cls;
    if (sys !== systemId && cls && isExit(cls)) {
      const path: number[] = [];
      for (let cur = sys; cur !== systemId; cur = prev.get(cur)!) path.unshift(cur);
      return { system: sys, path };
    }
    for (const c of ctx.chain.adj.get(sys) ?? []) {
      const far = farSide(c, sys);
      if (isRealSystemId(far) && !seen.has(far)) {
        seen.add(far);
        prev.set(far, sys);
        queue.push(far);
      }
    }
  }
  return null;
}

export async function buildKillEmbed(k: Kill, ctx: KillContext): Promise<EmbedBuilder> {
  const u = ctx.opts.universe;
  const ids = [k.victim.characterId, k.victim.corporationId, k.victim.shipTypeId,
    k.finalBlow?.characterId, k.finalBlow?.corporationId, k.finalBlow?.shipTypeId,
    ...k.attackerList.slice(0, 50).map((a) => a.corporationId)].filter((x): x is number => typeof x === 'number');
  await ctx.esi.resolveNames(ids);
  const n = (id: number | null | undefined, fb = 'unknown') => ctx.esi.name(id, fb);

  const side = sideOf(k, ctx);
  const sys = u.systems.get(k.systemId);
  const sysName = sys?.name ?? `#${k.systemId}`;
  const ship = n(k.victim.shipTypeId, 'something');
  const when = `<t:${Math.floor(k.time.getTime() / 1000)}:R>`;

  // Who: victim and final blow, each as "Pilot · Corp [TICK] <ALLY>".
  const victimWho = k.victim.characterId
    ? await affiliation(ctx, k.victim.characterId, k.victim.corporationId, k.victim.allianceId, 'someone')
    : (k.victim.corporationId ? await affiliation(ctx, null, k.victim.corporationId, k.victim.allianceId, 'a structure') : '**unknown**');
  const fb = k.finalBlow;
  const fbWho = fb ? (fb.characterId ? await affiliation(ctx, fb.characterId, fb.corporationId, fb.allianceId, 'someone') : '**NPC**') : null;
  const fbShip = fb?.shipTypeId ? n(fb.shipTypeId, 'unknown ship') : null;

  // The gang, folded to corps with counts.
  const byCorp = new Map<number, number>();
  for (const a of k.attackerList) if (a.corporationId) byCorp.set(a.corporationId, (byCorp.get(a.corporationId) ?? 0) + 1);
  const gangRows: string[] = [];
  for (const [corpId, count] of [...byCorp].sort((x, y) => y[1] - x[1]).slice(0, 6)) {
    const corp = await ctx.esi.corp(corpId);
    const alliance = corp?.allianceId ? await ctx.esi.alliance(corp.allianceId) : null;
    gangRows.push(`${corp ? `${corp.name} [${corp.ticker}]` : n(corpId)}${alliance ? ` <${alliance.ticker}>` : ''} ×${count}`);
  }
  if (byCorp.size > 6) gangRows.push(`+${byCorp.size - 6} more corps`);

  // The story, one paragraph.
  const gang = k.npc ? 'NPCs' : k.solo ? 'a solo pilot' : `a gang of ${k.attackers}`;
  const story = [
    `${victimWho} lost ${/^[aeiou]/i.test(ship) ? 'an' : 'a'} **${ship}** worth **${fmtIsk(k.totalValue)}** ISK to ${gang}${k.awox ? ' (awox)' : ''}.`,
    fbWho ? `Final blow: ${fbWho}${fbShip ? ` in ${/^[aeiou]/i.test(fbShip) ? 'an' : 'a'} **${fbShip}**` : ''}.` : null,
    `${when}.`,
  ].filter(Boolean).join(' ');

  const title = side === 'loss' ? `☠️ We lost a ${ship} in ${sysName}` : side === 'kill' ? `🎯 We killed a ${ship} in ${sysName}` : `💥 ${ship} down in ${sysName}`;
  const embed = new EmbedBuilder()
    .setAuthor({ name: AUTHOR, ...(ctx.avatarUrl ? { iconURL: ctx.avatarUrl } : {}) })
    .setTitle(title)
    .setURL(`https://zkillboard.com/kill/${k.id}/`)
    .setColor(side === 'loss' ? COLOUR.red : side === 'kill' ? COLOUR.green : COLOUR.orange)
    .setDescription(story)
    .setThumbnail(k.victim.shipTypeId ? `https://images.evetech.net/types/${k.victim.shipTypeId}/render?size=128` : null)
    .setFooter({ text: 'zKillboard · the map as it was at the last poll' })
    .setTimestamp(k.time);

  // Where it happened, in chain terms: the system, the way in, the way out.
  const jumps = ctx.homes.map((h) => shortestPath(ctx.chain, h, k.systemId)?.length).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b)[0];
  const whereBits = [systemLabel(ctx.opts, k.systemId), `[zKill](https://zkillboard.com/system/${k.systemId}/)`];
  if (jumps !== undefined) whereBits.push(jumps === 0 ? 'home' : `${jumps} hop${jumps === 1 ? '' : 's'} from home`);
  const holes = holesInto(ctx, k.systemId);
  const wayIn = holes.slice(0, 3).map(({ c, landing, entry, scanner }) => {
    const far = farSide(c, k.systemId);
    return `${fmtSig(landing.sigId)} from ${systemLabel(ctx.opts, far)} ${fmtSig(entry.sigId)} · scanned by **${scanner}** ${ago(landing.createdAt, ctx.opts.now)}`;
  });
  if (holes.length > 3) wayIn.push(`+${holes.length - 3} more holes`);
  const exit = sys && !isExit(sys.cls) ? nearestExit(ctx, k.systemId) : null;
  const wayOut = exit
    ? `${exit.path.length} hop${exit.path.length === 1 ? '' : 's'}: ${[k.systemId, ...exit.path].map((id) => { const s = u.systems.get(id); return s ? nameLink(ctx.opts, s) : `#${id}`; }).join(' → ')}`
    : sys && isExit(sys.cls) ? 'this is an exit' : null;

  embed.addFields({ name: 'Where', value: whereBits.join(' · ') });
  if (wayIn.length) embed.addFields({ name: holes.length === 1 ? 'Way in' : 'Ways in', value: wayIn.join('\n') });
  if (wayOut) embed.addFields({ name: 'Way out', value: wayOut });
  if (!k.npc && gangRows.length) embed.addFields({ name: `Gang · ${k.attackers} pilot${k.attackers === 1 ? '' : 's'}`, value: gangRows.join('\n') });
  return embed;
}
