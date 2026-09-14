/**
 * The chain panel: one message, five tabs, edited in place. Every control's
 * customId carries the whole state — `cp|tab|root[|action]` — so a click
 * needs no session.
 */
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder,
  type ButtonInteraction, type StringSelectMenuInteraction,
} from 'discord.js';
import { components as fragments, reachable, shortestPath, spanningTree, treeSystems, type Chain } from '../chain/graph.js';
import { ghostReport } from '../chain/ghosts.js';
import { ago, connectionSummary, renderExits, renderTree, systemLabel, systemUrl, type Exit, type RenderOpts } from '../chain/render.js';
import { isExit, isKSpace, type Universe } from '../universe/index.js';
import { buildUnknownEmbed } from './alerts.js';
import type { BotContext } from './commands.js';
import { embedsFromLines } from './embeds.js';
import { encodeState, defaultState, routeModal } from './routeUi.js';
import { COLOUR, empty } from './voice.js';

export type Tab = 'chain' | 'exits' | 'eol' | 'unknown' | 'activity';
export interface PanelState {
  tab: Tab;
  /** A chosen root system, or null for the configured homes. */
  root: number | null;
}

const TABS: { tab: Tab; label: string; emoji: string }[] = [
  { tab: 'chain', label: 'Chain', emoji: '🗺️' },
  { tab: 'exits', label: 'Exits', emoji: '🚪' },
  { tab: 'eol', label: 'EOL', emoji: '⏳' },
  { tab: 'unknown', label: 'Unknown', emoji: '❓' },
  { tab: 'activity', label: 'Activity', emoji: '💥' },
];

export const encodePanel = (st: PanelState, action = '') => `cp|${st.tab}|${st.root ?? 0}${action ? `|${action}` : ''}`;

export function decodePanel(id: string): { state: PanelState; action: string } | null {
  const [tag, tab, root, action] = id.split('|');
  if (tag !== 'cp' || !TABS.some((t) => t.tab === tab)) return null;
  return { state: { tab: tab as Tab, root: Number(root) || null }, action: action ?? '' };
}

function opts(ctx: BotContext): RenderOpts {
  return { universe: ctx.universe, now: new Date(), home: new Set(ctx.homes), tripwireUrl: ctx.config.tripwire.url, md: true };
}

function footer(ctx: BotContext, chain: Chain): string {
  return `${ctx.config.tripwire.label} · data ${ago(chain.fetchedAt, new Date())}`;
}

/** The roots a view draws from: the chosen root, else every home, else the biggest fragment. */
export function rootsFor(ctx: BotContext, chain: Chain, st: PanelState): number[] {
  if (st.root) return [st.root];
  if (ctx.homes.length) return ctx.homes;
  const biggest = fragments(chain)[0];
  return biggest?.length ? [biggest[0]!] : [];
}

const name = (u: Universe, id: number) => u.systems.get(id)?.name ?? `#${id}`;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

interface View {
  embeds: EmbedBuilder[];
  /** Systems worth a "route here" button, in order. */
  routeTargets?: { id: number; label: string }[];
}

function chainView(ctx: BotContext, chain: Chain, roots: number[]): View {
  const o = opts(ctx);
  const lines: string[] = [];
  const shown = new Set<number>();
  for (const root of roots) {
    if (shown.has(root)) continue;
    const tree = spanningTree(chain, root);
    if (lines.length) lines.push('');
    lines.push(...renderTree(tree, o));
    if (!tree.children.length && !tree.loops.length) lines.push(`　*${empty.chain(systemLabel({ ...o, md: false }, root))}*`);
    for (const s of treeSystems(tree)) shown.add(s);
  }
  const elsewhere = fragments(chain).filter((g) => !g.some((s) => shown.has(s)));
  if (elsewhere.length) {
    lines.push('', `**Elsewhere on the map** · ${elsewhere.length} fragment${elsewhere.length === 1 ? '' : 's'} not connected to the above`);
    for (const g of elsewhere.slice(0, 8)) lines.push(`└ ${g.slice(0, 6).map((s) => systemLabel(o, s)).join(' · ')}${g.length > 6 ? ` · +${g.length - 6} more` : ''}`);
  }
  if (!lines.length) lines.push(`*${empty.map}*`);
  const first = roots[0];
  return { embeds: embedsFromLines({ title: `Chain from ${first ? name(ctx.universe, first) : 'home'}`, url: first ? systemUrl(o, name(ctx.universe, first)) : null, colour: COLOUR.orange, lines, footer: footer(ctx, chain), authorIcon: ctx.avatarUrl }) };
}

function exitsView(ctx: BotContext, chain: Chain, roots: number[]): View {
  const o = opts(ctx);
  const lines: string[] = [];
  const targets: { id: number; label: string }[] = [];
  for (const root of roots) {
    const found: Exit[] = [];
    for (const id of reachable(chain, root)) {
      const s = ctx.universe.systems.get(id);
      if (!s || !isExit(s.cls) || id === root) continue;
      const path = shortestPath(chain, root, id);
      if (path) found.push({ system: s, path });
    }
    found.sort((x, y) => x.path.length - y.path.length || x.system.name.localeCompare(y.system.name));
    if (lines.length) lines.push('');
    if (roots.length > 1) lines.push(`From ${systemLabel(o, root)}`);
    lines.push(...(found.length ? renderExits(found, root, o) : [`*${empty.exits}*`]));
    for (const e of found) if (targets.length < 10 && !targets.some((t) => t.id === e.system.id)) targets.push({ id: e.system.id, label: `${e.system.name} · ${e.path.length}j` });
  }
  const first = roots[0];
  return {
    embeds: embedsFromLines({ title: `Exits from ${first ? name(ctx.universe, first) : 'home'}`, url: first ? systemUrl(o, name(ctx.universe, first)) : null, colour: COLOUR.teal, lines, footer: footer(ctx, chain), authorIcon: ctx.avatarUrl }),
    routeTargets: targets,
  };
}

function eolView(ctx: BotContext, chain: Chain): View {
  const o = opts(ctx);
  const flagged = [...chain.connections.values()]
    .filter((c) => c.life === 'critical' || c.mass !== 'stable')
    .sort((x, y) => (x.expiresAt?.getTime() ?? Infinity) - (y.expiresAt?.getTime() ?? Infinity));
  const lines = flagged.length ? flagged.map((c) => `└ ${connectionSummary(c, o)}`) : [`*${empty.eol}*`];
  return { embeds: embedsFromLines({ title: flagged.length ? `${flagged.length} connection${flagged.length === 1 ? '' : 's'} on borrowed time` : 'Nothing on borrowed time', colour: flagged.length ? COLOUR.red : COLOUR.green, lines, footer: footer(ctx, chain), authorIcon: ctx.avatarUrl }) };
}

function unknownView(ctx: BotContext, chain: Chain): View {
  const report = ghostReport(chain, ctx.universe);
  if (!report.ghosts.length && !report.unidentified.length) return { embeds: embedsFromLines({ title: 'No unknown holes', colour: COLOUR.green, lines: ['*Every known-space hole on the map has an ID. The automapper has been behaving.*'], footer: footer(ctx, chain), authorIcon: ctx.avatarUrl }) };
  return { embeds: [buildUnknownEmbed(report, opts(ctx), ctx.avatarUrl)] };
}

async function activityView(ctx: BotContext, chain: Chain, roots: number[]): Promise<View> {
  const o = opts(ctx);
  const u = ctx.universe;
  const act = await ctx.esi.systemActivity();
  const systems = new Set<number>();
  for (const root of roots) for (const id of reachable(chain, root)) systems.add(id);
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;
  const feed = ctx.killWatch;
  const rows = [...systems].map((id) => {
    const s = u.systems.get(id);
    const kspace = !!s && isKSpace(s.cls);
    if (kspace) {
      const a = act.get(id) ?? { shipKills: 0, podKills: 0, npcKills: 0, jumps: 0 };
      return { id, kspace, hour: a.shipKills + a.podKills, day: null as number | null, jumps: a.jumps, npc: a.npcKills };
    }
    const k = feed ? feed.kills(id, DAY) : [];
    const pvp = k.filter((x) => !x.npc);
    return { id, kspace, hour: pvp.filter((x) => x.time >= Date.now() - HOUR).length, day: pvp.length, jumps: 0, npc: k.length - pvp.length };
  });
  const hot = rows.filter((r) => r.hour || r.day || r.jumps);
  hot.sort((x, y) => y.hour - x.hour || (y.day ?? 0) - (x.day ?? 0) || y.jumps - x.jumps);
  const lines = hot.map((r) => {
    const bits = [systemLabel(o, r.id)];
    if (r.hour) bits.push(`💥 ${r.hour} kill${r.hour === 1 ? '' : 's'} last hour`);
    if (!r.kspace && r.day) bits.push(`${r.hour ? '' : '💥 '}${r.day} in 24h`);
    if (r.jumps) bits.push(`🚀 ${r.jumps} jump${r.jumps === 1 ? '' : 's'}`);
    if (r.npc) bits.push(`🤖 ${r.npc} rats`);
    return bits.join(' · ');
  });
  const quiet = rows.length - hot.length;
  if (!lines.length) lines.push(`*Nothing has died and nobody has moved in ${rows.length} systems. Trippy is not reassured.*`);
  else if (quiet) lines.push('', `*${quiet} more system${quiet === 1 ? '' : 's'} with nothing to report.*`);
  if (rows.some((r) => !r.kspace)) {
    const since = feed?.startedAt ? Date.now() - feed.startedAt.getTime() : 0;
    lines.push('', feed
      ? `*J-space counts come from zKillboard's live feed${since < DAY ? `, watched for ${ago(feed.startedAt!, new Date()).replace(' ago', '')} so far` : ''}; k-space jumps and kills from ESI.*`
      : '*Kill feed is off, so J-space shows nothing. ESI has no wormhole kill data.*');
  }
  return { embeds: embedsFromLines({ title: `Activity across ${rows.length} chain system${rows.length === 1 ? '' : 's'}`, colour: hot.some((r) => r.hour) ? COLOUR.red : COLOUR.green, lines, footer: footer(ctx, chain), authorIcon: ctx.avatarUrl }) };
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export function panelComponents(ctx: BotContext, chain: Chain, st: PanelState, view: View): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  const u = ctx.universe;
  const tabs = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...TABS.map((t) => new ButtonBuilder().setCustomId(encodePanel({ ...st, tab: t.tab }) + (t.tab === st.tab ? '|=' : ''))
      .setLabel(t.label).setEmoji(t.emoji).setStyle(t.tab === st.tab ? ButtonStyle.Primary : ButtonStyle.Secondary).setDisabled(t.tab === st.tab)),
  );
  const tools = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(encodePanel(st, 'refresh')).setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(encodePanel(st, 'plan')).setLabel('Plan a route').setEmoji('🧭').setStyle(ButtonStyle.Secondary),
  );
  // Root select: homes first, then one entry per other fragment.
  const options: { label: string; value: string; description?: string; emoji?: string; default?: boolean }[] = [];
  if (ctx.homes.length) options.push({ label: ctx.homes.length > 1 ? 'All homes' : `Home · ${name(u, ctx.homes[0]!)}`, value: '0', emoji: '🏠', default: st.root === null });
  for (const h of ctx.homes) if (ctx.homes.length > 1) options.push({ label: `Home · ${name(u, h)}`, value: String(h), emoji: '🏠', default: st.root === h });
  const homeSet = new Set(ctx.homes);
  for (const g of fragments(chain)) {
    if (options.length >= 25) break;
    if (g.some((s) => homeSet.has(s))) continue;
    const lead = g.find((s) => !isKSpace(u.systems.get(s)?.cls ?? 'unknown')) ?? g[0]!;
    options.push({ label: `${name(u, lead)} · ${g.length} system${g.length === 1 ? '' : 's'}`, value: String(lead), description: g.slice(0, 4).map((s) => name(u, s)).join(', '), emoji: '🧩', default: st.root === lead });
  }
  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [tabs, tools];
  if (options.length > 1) {
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(encodePanel(st, 'root')).setPlaceholder('Root the view at…').addOptions(options),
    ));
  }
  // "Route here" buttons, up to two rows.
  const from = rootsFor(ctx, chain, st)[0];
  const targets = view.routeTargets ?? [];
  if (from && targets.length) {
    for (let r = 0; r < 2 && r * 5 < targets.length; r++) {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...targets.slice(r * 5, r * 5 + 5).map((t) => new ButtonBuilder().setCustomId(`${encodeState(defaultState(from, t.id))}|go`).setLabel(`→ ${t.label}`).setStyle(ButtonStyle.Secondary)),
      ));
    }
  }
  return rows;
}

export async function renderPanel(ctx: BotContext, chain: Chain, st: PanelState): Promise<{ embeds: EmbedBuilder[]; components: ReturnType<typeof panelComponents> }> {
  const roots = rootsFor(ctx, chain, st);
  const view = st.tab === 'chain' ? chainView(ctx, chain, roots)
    : st.tab === 'exits' ? exitsView(ctx, chain, roots)
      : st.tab === 'eol' ? eolView(ctx, chain)
        : st.tab === 'unknown' ? unknownView(ctx, chain)
          : await activityView(ctx, chain, roots);
  return { embeds: view.embeds.slice(0, 10), components: panelComponents(ctx, chain, st, view) };
}

/** Tabs, refresh, root select, plan. */
export async function handlePanelComponent(i: ButtonInteraction | StringSelectMenuInteraction, ctx: BotContext): Promise<void> {
  const parsed = decodePanel(i.customId);
  if (!parsed) return;
  let { state: st } = parsed;
  if (parsed.action === 'plan') {
    const home = ctx.homes[0];
    await i.showModal(routeModal(home ? name(ctx.universe, home) : null, st.root ? name(ctx.universe, st.root) : ''));
    return;
  }
  await i.deferUpdate();
  if (i.isStringSelectMenu()) st = { ...st, root: Number(i.values[0]) || null };
  const chain = parsed.action === 'refresh' ? await ctx.store.refresh().catch(() => ctx.store.get(0)) : await ctx.store.get(15_000);
  const out = await renderPanel(ctx, chain, st);
  await i.editReply({ embeds: out.embeds, components: out.components });
}
