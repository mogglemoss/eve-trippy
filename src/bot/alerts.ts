/**
 * Turns chain events into Discord embeds for the alert channel.
 */
import { EmbedBuilder } from 'discord.js';
import type { ChainEvent } from '../chain/diff.js';
import { shortestPath, type Chain, type Connection } from '../chain/graph.js';
import { ago, connectionSummary, fmtSig, holeInfo, systemHeadline, systemLabel, systemUrl, type RenderOpts } from '../chain/render.js';
import { AUTHOR, COLOUR } from './voice.js';
import { isExit, isKSpace, isRealSystemId } from '../universe/index.js';
import { proximities } from '../chain/near.js';
import { GHOST_MAX_GATES, gateDistance } from '../chain/ghosts.js';
import type { AlertKind, AlertToggles, Watch } from './prefs.js';

const COLOURS = {
  connected: COLOUR.green,
  exit: COLOUR.blue,
  identified: COLOUR.purple,
  mass: COLOUR.red,
} as const;

/** After a long outage the diff can be the whole map; do not paste it all. */
const MAX_LINES = 40;

function title(events: ChainEvent[], opts: RenderOpts): string {
  const n = events.length;
  const kinds = new Set(events.map((e) => e.kind));
  if (n === 1) {
    const only = events[0]!;
    switch (only.kind) {
      case 'connected': return leadsToExit(only.c, opts) ? 'New exit' : 'New connection';
      case 'identified': return 'Far side identified';
      case 'mass': return only.c.mass === 'critical' ? 'A hole is nearly spent' : 'A hole is getting heavy';
      case 'ghost': return 'An unknown hole appeared';
    }
  }
  if (kinds.size === 1 && kinds.has('connected')) {
    return events.every((e) => e.kind === 'connected' && leadsToExit(e.c, opts)) ? `${n} new exits` : `${n} new connections`;
  }
  return `${n} changes on the map`;
}

/** Which toggle governs a chain event. */
export function alertKindOf(e: ChainEvent, opts: RenderOpts): AlertKind {
  switch (e.kind) {
    case 'connected': return leadsToExit(e.c, opts) ? 'exit' : 'connection';
    case 'identified': return 'identified';
    case 'mass': return e.c.mass === 'critical' ? 'spent' : 'heavy';
    case 'ghost': return 'ghost';
  }
}

/**
 * The events that should be posted: their kind is switched on, or they are a
 * new hole near a watched place, which somebody asked for by name.
 */
export function filterAlertEvents(events: ChainEvent[], toggles: AlertToggles, opts: RenderOpts, watches: Watch[] = []): ChainEvent[] {
  return events.filter((e) => toggles[alertKindOf(e, opts)] || (e.kind === 'connected' && proximityLines(e.c, opts, watches).length > 0));
}

const RANK: Record<ChainEvent['kind'], number> = { mass: 0, connected: 1, identified: 2, ghost: 3 };

function leadsToExit(c: Connection, opts: RenderOpts): boolean {
  return [c.a, c.b].some((id) => {
    if (!isRealSystemId(id)) return false;
    const s = opts.universe.systems.get(id);
    return !!s && isExit(s.cls);
  });
}

function line(e: ChainEvent, opts: RenderOpts): string {
  const u = opts.universe;
  switch (e.kind) {
    case 'connected': {
      const exit = leadsToExit(e.c, opts);
      const who = e.c.createdBy ? ` — ${e.c.createdBy}` : '';
      const info = holeInfo(u, e.c);
      return `${exit ? '🚪' : '🟢'} **New${exit ? ' exit' : ''}** ${connectionSummary(e.c, opts)}${who}${info ? `\n　${info}` : ''}`;
    }
    case 'ghost':
      return `👻 **Unknown hole** ${connectionSummary(e.c, opts)}`;
    case 'identified':
      return `🔎 **Identified** ${connectionSummary(e.c, opts)} (was ${systemLabel(opts, e.from.a)} ⇄ ${systemLabel(opts, e.from.b)})`;
    case 'mass':
      return `${e.c.mass === 'critical' ? '🔴' : '🟡'} **Mass ${e.c.mass === 'critical' ? 'critical' : 'destabilised'}** ${connectionSummary(e.c, opts)} (was ${e.from})`;
  }
}

/** "📍 3 gates from Jita" lines for a new k-space end, per configured watch. */
export function proximityLines(c: Connection, opts: RenderOpts, watches: Watch[]): string[] {
  if (!watches.length) return [];
  const u = opts.universe;
  const lines: string[] = [];
  for (const id of [c.a, c.b]) {
    if (!isRealSystemId(id)) continue;
    const s = u.systems.get(id);
    if (!s || !isKSpace(s.cls)) continue;
    for (const p of proximities(u, id, watches)) {
      if (p.systemId !== null) {
        const target = u.systems.get(p.systemId)?.name ?? `#${p.systemId}`;
        lines.push(p.gates === 0 ? `　📍 that is **${target}** itself` : `　📍 **${p.gates} gate${p.gates === 1 ? '' : 's'} from ${target}**`);
      } else if (p.region) {
        lines.push(`　📍 in **${p.region}**`);
      }
    }
  }
  return [...new Set(lines)];
}

/**
 * Unknown holes: wormhole rows joining two known-space systems with no sig IDs
 * and no named type. Two kinds, one list. A **ghost** is one whose ends are a
 * few gates apart: the automapper followed a pilot through gates and drew a
 * hole that never existed. Delete it. An **unidentified** hole is the same row
 * with its ends far apart: probably real, nobody scanned it. Identify it.
 *
 * One line per hole, newest first, so the list reads like a to-do list.
 */
export function buildUnknownEmbed(report: { ghosts: Connection[]; unidentified: Connection[] }, opts: RenderOpts, avatarUrl: string | null = null): EmbedBuilder {
  const { ghosts, unidentified } = report;
  const u = opts.universe;
  const total = ghosts.length + unidentified.length;
  const link = (id: number | null) => {
    const s = id === null ? undefined : u.systems.get(id);
    return s ? `**[${s.name}](${systemUrl(opts, s.name) ?? ''})**` : `**${id ?? '?'}**`;
  };
  // The automapper often draws the same ghost several times; fold identical pairs.
  type Group = { c: Connection; count: number; born: number };
  const fold = (list: Connection[]): Group[] => {
    const groups = new Map<string, Group>();
    for (const c of list) {
      const key = [c.a, c.b].sort((x, y) => (x ?? 0) - (y ?? 0)).join('-');
      const born = Math.min(c.sigA.createdAt.getTime(), c.sigB.createdAt.getTime());
      const g = groups.get(key);
      if (g) { g.count += 1; g.born = Math.min(g.born, born); }
      else groups.set(key, { c, count: 1, born });
    }
    return [...groups.values()].sort((x, y) => y.born - x.born);
  };
  const row = (g: Group, kind: 'ghost' | 'unidentified') => {
    const { c } = g;
    const gates = kind === 'ghost' ? gateDistance(u, c.a!, c.b!, GHOST_MAX_GATES) : null;
    const bits = [
      `${kind === 'ghost' ? '👻' : '🔍'} ${link(c.a)} ↔ ${link(c.b)}${g.count > 1 ? ` ×${g.count}` : ''}`,
      gates === null ? null : `${gates} gate${gates === 1 ? '' : 's'} apart`,
      `by ${c.createdBy || 'unknown'}`,
      ago(new Date(g.born), opts.now),
    ].filter(Boolean);
    return bits.join(' · ');
  };
  // Fill the description line by line so it never cuts mid-entry.
  const lines: string[] = [];
  let size = 0;
  const push = (line: string) => { if (size + line.length + 1 > 3900) return false; lines.push(line); size += line.length + 1; return true; };
  const section = (title: string, groups: Group[], kind: 'ghost' | 'unidentified') => {
    if (!groups.length) return;
    if (lines.length) push('');
    push(title);
    let shown = 0;
    for (const g of groups) { if (!push(row(g, kind))) break; shown += 1; }
    if (shown < groups.length) push(`…and ${groups.length - shown} more`);
  };
  const ghostGroups = fold(ghosts);
  const unidGroups = fold(unidentified);
  section(`**Ghosts · ${ghosts.length}${ghostGroups.length < ghosts.length ? ` (${ghostGroups.length} distinct)` : ''}** — ends ${GHOST_MAX_GATES} gates or fewer apart; the automapper drew a hole where a pilot took gates. *Delete these.*`, ghostGroups, 'ghost');
  section(`**Unidentified · ${unidentified.length}** — too far apart by gate to be ghosts; probably real, never scanned. *Identify these.*`, unidGroups, 'unidentified');
  return new EmbedBuilder()
    .setAuthor({ name: AUTHOR, ...(avatarUrl ? { iconURL: avatarUrl } : {}) })
    .setColor(ghosts.length ? COLOUR.purple : COLOUR.teal)
    .setTitle(`${total} unknown hole${total === 1 ? '' : 's'} on the map`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Known space both ends, no sig IDs, no type. Trippy reads; the deleting is yours.' });
}

/** @deprecated name kept for callers; see buildUnknownEmbed */
export const buildGhostEmbed = buildUnknownEmbed;

export function buildAlertEmbeds(events: ChainEvent[], chain: Chain, opts: RenderOpts, source: string, avatarUrl: string | null = null, watches: Watch[] = []): EmbedBuilder[] {
  const sorted = [...events].filter((e) => e.kind !== 'ghost').sort((x, y) => RANK[x.kind] - RANK[y.kind]);
  if (!sorted.length) return [];
  const lines = sorted.slice(0, MAX_LINES).map((e) => {
    const base = line(e, opts);
    if (e.kind === 'connected' || e.kind === 'identified') {
      const near = proximityLines(e.c, opts, watches);
      if (near.length) return `${base}\n${near.join('\n')}`;
    }
    return base;
  });
  if (sorted.length > MAX_LINES) lines.push(`… and ${sorted.length - MAX_LINES} more changes; run /chain for the full picture.`);
  const worst = sorted[0];
  const colour = !worst
    ? COLOUR.grey
    : worst.kind === 'connected' && leadsToExit(worst.c, opts)
      ? COLOURS.exit
      : COLOURS[worst.kind];

  const embeds: EmbedBuilder[] = [];
  let buffer: string[] = [];
  let size = 0;
  const flush = () => {
    if (!buffer.length) return;
    embeds.push(
      new EmbedBuilder()
        .setColor(colour)
        .setAuthor({ name: AUTHOR, ...(avatarUrl ? { iconURL: avatarUrl } : {}) })
        .setTitle(embeds.length === 0 ? title(sorted, opts) : 'Chain update (cont.)')
        .setDescription(buffer.join('\n'))
        .setFooter({ text: `${source} · ${chain.connections.size} connections · ${chain.fetchedAt.toISOString().slice(11, 16)} UTC` }),
    );
    buffer = [];
    size = 0;
  };
  for (const l of lines) {
    if (size + l.length + 1 > 3900) flush();
    buffer.push(l);
    size += l.length + 1;
  }
  flush();
  return embeds;
}

/** "🎯 Wanted: J101507 is on the map" — how it is connected, hops from home, who asked. */
export function buildWantedEmbed(systemId: number, userIds: string[], chain: Chain, opts: RenderOpts, homes: number[], avatarUrl: string | null = null): EmbedBuilder {
  const u = opts.universe;
  const s = u.systems.get(systemId);
  const name = s?.name ?? `#${systemId}`;
  const lines: string[] = [];
  const hops = homes.map((h) => shortestPath(chain, h, systemId)?.length).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b)[0];
  lines.push(`${s ? systemHeadline(opts, s) : name}${hops === undefined ? '' : hops === 0 ? ' · **home**' : ` · **${hops} hop${hops === 1 ? '' : 's'} from home**`}`);
  const conns = chain.adj.get(systemId) ?? [];
  if (conns.length) {
    lines.push('');
    for (const c of conns.slice(0, 8)) lines.push(`└ ${connectionSummary(c, opts)}`);
    if (conns.length > 8) lines.push(`└ …and ${conns.length - 8} more`);
  }
  lines.push('', `Asked for by ${userIds.map((id) => `<@${id}>`).join(', ')}`);
  return new EmbedBuilder()
    .setAuthor({ name: AUTHOR, ...(avatarUrl ? { iconURL: avatarUrl } : {}) })
    .setColor(COLOUR.amber)
    .setTitle(`🎯 Wanted: ${name} is on the map`)
    .setURL(systemUrl(opts, name))
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'It stays on the wanted list until someone removes it; the alert fires again if it leaves and comes back.' });
}
