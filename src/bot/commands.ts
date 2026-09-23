/**
 * Slash commands. Each handler reads the chain from the store (refreshing it
 * when older than a few seconds), renders markdown lines, and answers in
 * embeds with the systems linked back to Tripwire.
 */
import {
  ActionRowBuilder, type AutocompleteInteraction, ButtonBuilder, type ButtonInteraction, ButtonStyle, type ChatInputCommandInteraction, EmbedBuilder, MessageFlags, SlashCommandBuilder,
  type ModalSubmitInteraction, type StringSelectMenuInteraction,
} from 'discord.js';
import type { Config } from '../config.js';
import { components, reachable, shortestPath, spanningTree, treeSystems, type Chain } from '../chain/graph.js';
import {
  ago, connectionSummary, nameLink, renderExits, renderSigs, renderTree, systemHeadline, systemLabel, systemUrl,
  type Exit, type RenderOpts,
} from '../chain/render.js';
import { TripwireClient, TripwireError } from '../tripwire/client.js';
import { findSystem, isExit, isKSpace as isKSpaceCls, searchSystems, type SystemInfo, type Universe } from '../universe/index.js';
import { embedsFromLines, sendEmbeds } from './embeds.js';
import { ALERT_INFO, ALERT_KINDS, type AlertKind, type PrefsStore } from './prefs.js';
import type { Esi } from '../esi.js';
import { htmlToMarkdown } from '../html.js';
import type { EveScout } from '../scout.js';
import type { KillWatch } from './killwatch.js';
import { nearestMapped } from '../chain/near.js';
import { renderPanel, type Tab } from './panel.js';
import { alertsPanel, avoidModal, avoidPanel, notesModal, watchModal, watchPanel } from './listsUi.js';
import { StringSelectMenuBuilder } from 'discord.js';
import { defaultState, encodeState, renderRouteReply, routeModal, stateFromInteraction, type RouteState } from './routeUi.js';
import type { ChainStore } from './store.js';
import { AUTHOR, COLOUR, empty, regrets } from './voice.js';

export interface BotContext {
  config: Config;
  universe: Universe;
  tripwire: TripwireClient;
  store: ChainStore;
  /** Resolved home system IDs, in configured order. */
  homes: number[];
  startedAt: Date;
  /** The bot's avatar, for embed author lines. */
  avatarUrl: string | null;
  prefs: PrefsStore;
  esi: Esi;
  scout: EveScout;
  killWatch: KillWatch | null;
}

/** A message meant for the user, not a bug. */
export class UserError extends Error {}

const FRESH_MS = 15_000;

const systemOption = (name: string, description: string, required: boolean) =>
  (b: SlashCommandBuilder) =>
    b.addStringOption((o) => o.setName(name).setDescription(description).setRequired(required).setAutocomplete(true));

export const commands = [
  new SlashCommandBuilder().setName('chain').setDescription('Draw the chain outward from home (or from a system).'),
  new SlashCommandBuilder().setName('route').setDescription('Plan a route through chains and gates: from a system, to a system.'),
  new SlashCommandBuilder().setName('exits').setDescription('Every k-space and Thera exit in the chain, nearest first.'),
  new SlashCommandBuilder().setName('sigs').setDescription('Signatures in a system.'),
  new SlashCommandBuilder().setName('notes').setDescription('Tripwire comments: on a system, or search all of them.'),
  new SlashCommandBuilder().setName('eol').setDescription('Connections that are end-of-life or mass-reduced.'),
  new SlashCommandBuilder().setName('status').setDescription("Trippy's health and where the data comes from."),
  new SlashCommandBuilder().setName('activity').setDescription('Kills and jumps in the last hour across the chain (ESI).'),
  new SlashCommandBuilder().setName('near').setDescription('The nearest mapped systems to a k-space system, by gates, across every chain.'),
  new SlashCommandBuilder().setName('unknown').setDescription('Unknown holes: known-space rows with no sig IDs or type. Ghosts to delete, unidentified to scan.'),
  new SlashCommandBuilder().setName('alerts').setDescription('Which alerts Trippy posts: see every kind and switch each on or off.'),
];
commands[10]!
  .addStringOption((o) => o.setName('kind').setDescription('An alert kind to switch (leave blank to just look)').setRequired(false)
    .addChoices(...ALERT_KINDS.map((k) => ({ name: ALERT_INFO[k].label, value: k }))))
  .addStringOption((o) => o.setName('state').setDescription('on or off (blank = flip it)').setRequired(false).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }));
systemOption('from', 'Chain rooted here instead of home', false)(commands[7]!);
systemOption('system', 'A k-space system, e.g. Jita', true)(commands[8]!);
const watchCommand = new SlashCommandBuilder().setName('watch').setDescription('Announce new exits near places you care about (per server).')
  .addSubcommand((sc) => sc.setName('add').setDescription('Watch a system or a region')
    .addStringOption((o) => o.setName('place').setDescription('System name, or a region name').setRequired(true).setAutocomplete(true))
    .addIntegerOption((o) => o.setName('gates').setDescription('Within this many gates of the system (default 5; ignored for regions)').setMinValue(0).setMaxValue(20)))
  .addSubcommand((sc) => sc.setName('remove').setDescription('Stop watching a place').addStringOption((o) => o.setName('place').setDescription('System or region name').setRequired(true).setAutocomplete(true)))
  .addSubcommand((sc) => sc.setName('list').setDescription('Show the watch list'));
const wantedCommand = new SlashCommandBuilder().setName('wanted').setDescription('Systems you want to hear about the moment they connect to the map (per server).')
  .addSubcommand((sc) => sc.setName('add').setDescription('Ping me when this system turns up on the map')
    .addStringOption((o) => o.setName('system').setDescription('System name or J-number').setRequired(true).setAutocomplete(true))
    .addBooleanOption((o) => o.setName('dm').setDescription('Tell me by direct message instead of in the channel').setRequired(false)))
  .addSubcommand((sc) => sc.setName('remove').setDescription('Stop waiting for a system').addStringOption((o) => o.setName('system').setDescription('System name or J-number').setRequired(true).setAutocomplete(true)))
  .addSubcommand((sc) => sc.setName('list').setDescription('Show the wanted list'));
const killsCommand = new SlashCommandBuilder().setName('kills').setDescription('Hear about every kill in a system, on the map or not, k-space included (per server).')
  .addSubcommand((sc) => sc.setName('watch').setDescription('Announce kills in this system')
    .addStringOption((o) => o.setName('system').setDescription('System name or J-number').setRequired(true).setAutocomplete(true))
    .addBooleanOption((o) => o.setName('dm').setDescription('Tell me by direct message instead of in the channel').setRequired(false)))
  .addSubcommand((sc) => sc.setName('unwatch').setDescription('Stop announcing kills in a system').addStringOption((o) => o.setName('system').setDescription('System name or J-number').setRequired(true).setAutocomplete(true)))
  .addSubcommand((sc) => sc.setName('list').setDescription('Show the systems being watched for kills'));
const avoidCommand = new SlashCommandBuilder().setName('avoid').setDescription('Systems /route steers around (per server).')
  .addSubcommand((sc) => sc.setName('add').setDescription('Avoid a system').addStringOption((o) => o.setName('system').setDescription('System name').setRequired(true).setAutocomplete(true)))
  .addSubcommand((sc) => sc.setName('remove').setDescription('Stop avoiding a system').addStringOption((o) => o.setName('system').setDescription('System name').setRequired(true).setAutocomplete(true)))
  .addSubcommand((sc) => sc.setName('list').setDescription('Show the avoid list'))
  .addSubcommand((sc) => sc.setName('clear').setDescription('Empty the avoid list'));
systemOption('from', 'Root the tree here instead of home', false)(commands[0]!);
systemOption('from', 'Where you are ("home" for the home system)', true)(commands[1]!);
systemOption('to', 'Where you are going', true)(commands[1]!);
systemOption('from', 'Measure from here instead of home', false)(commands[2]!);
systemOption('system', 'System name (J-number or k-space)', true)(commands[3]!);
systemOption('system', 'Show the notes on this system', false)(commands[4]!);
commands[4]!.addStringOption((o) => o.setName('find').setDescription('Search every note for this text').setRequired(false));

// Last, so every required option sits before it (Discord insists).
for (const c of commands) {
  c.addBooleanOption((o) => o.setName('quiet').setDescription('Reply only to you').setRequired(false));
}

export const commandData = [...commands, avoidCommand, watchCommand, wantedCommand, killsCommand].map((c) => c.toJSON());

// ---------------------------------------------------------------------------

/** Opsec: the map is corp intel. Null when allowed, else the reason. */
export function denied(i: { guildId: string | null; channelId: string | null; member: unknown }, ctx: BotContext): string | null {
  const { allowedRoleIds, allowedChannelIds } = ctx.config;
  if (allowedChannelIds.length && !allowedChannelIds.includes(i.channelId ?? '')) {
    return `Trippy only answers in ${allowedChannelIds.map((id) => `<#${id}>`).join(', ')}.`;
  }
  if (allowedRoleIds.length) {
    const roles = (i.member as { roles?: { cache?: Map<string, unknown> } | string[] } | null)?.roles;
    const has = Array.isArray(roles) ? roles.some((r) => allowedRoleIds.includes(r))
      : roles?.cache ? [...roles.cache.keys()].some((r) => allowedRoleIds.includes(r)) : false;
    if (!has) return 'This map is for pilots with the right badge. Ask an admin for the role.';
  }
  return null;
}

export async function handleCommand(i: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const why = denied(i, ctx);
  if (why) {
    await i.reply({ content: regrets(why), flags: MessageFlags.Ephemeral });
    return;
  }
  const quiet = i.options.getBoolean('quiet') ?? ctx.config.ephemeral;
  await i.deferReply(quiet ? { flags: MessageFlags.Ephemeral } : {});
  try {
    switch (i.commandName) {
      case 'chain': return await panel(i, ctx, 'chain');
      case 'route': return await route(i, ctx);
      case 'exits': return await panel(i, ctx, 'exits');
      case 'sigs': return await sigs(i, ctx);
      case 'notes': return await notes(i, ctx);
      case 'eol': return await panel(i, ctx, 'eol');
      case 'status': return await status(i, ctx);
      case 'avoid': return await avoid(i, ctx);
      case 'activity': return await panel(i, ctx, 'activity');
      case 'near': return await near(i, ctx);
      case 'unknown': return await panel(i, ctx, 'unknown');
      case 'watch': return await watch(i, ctx);
      case 'wanted': return await wanted(i, ctx);
      case 'kills': return await kills(i, ctx);
      case 'alerts': return await alerts(i, ctx);
      default: throw new UserError(`Unknown command /${i.commandName}`);
    }
  } catch (e) {
    const known = e instanceof UserError || e instanceof TripwireError;
    if (!known) console.error(e);
    await i.editReply({ content: regrets(known ? e.message : 'something went wrong; the log has the details.') });
  }
}

export async function handleAutocomplete(i: AutocompleteInteraction, ctx: BotContext): Promise<void> {
  const focused = i.options.getFocused(true);
  const q = focused.value.trim();
  const inChain = new Set(ctx.store.latest?.adj.keys() ?? []);
  const plain: RenderOpts = { universe: ctx.universe, now: new Date() };
  const chainMatches = [...inChain]
    .map((id) => ctx.universe.systems.get(id))
    .filter((s): s is SystemInfo => !!s && (q === '' || s.name.toLowerCase().startsWith(q.toLowerCase()) || (/^\d+$/.test(q) && s.name.toLowerCase().startsWith(`j${q}`))))
    .sort((a, b) => a.name.localeCompare(b.name));
  const rest = q ? searchSystems(ctx.universe, q, 25).filter((s) => !inChain.has(s.id)) : [];
  const choices = [...chainMatches, ...rest].slice(0, 25).map((s) => ({
    name: `${systemHeadline(plain, s)}${inChain.has(s.id) ? ' · in chain' : ''}`.slice(0, 100),
    value: s.name,
  }));
  if (focused.name === 'place' && q) {
    const regions = [...new Set([...ctx.universe.systems.values()].map((s) => s.region))]
      .filter((r) => r.toLowerCase().startsWith(q.toLowerCase())).sort().slice(0, 5)
      .map((r) => ({ name: `${r} (region)`, value: `region:${r}` }));
    choices.splice(0, Math.max(0, choices.length + regions.length - 25));
    choices.unshift(...regions);
  }
  await i.respond(choices.slice(0, 25));
}

// ---------------------------------------------------------------------------

function opts(ctx: BotContext): RenderOpts {
  return { universe: ctx.universe, now: new Date(), home: new Set(ctx.homes), tripwireUrl: ctx.config.tripwire.url, md: true };
}

function source(ctx: BotContext, chain?: Chain): string {
  const label = ctx.config.tripwire.label;
  return chain ? `${label} · data ${ago(chain.fetchedAt, new Date())}` : label;
}

function resolveSystem(ctx: BotContext, input: string): SystemInfo {
  const s = findSystem(ctx.universe, input);
  if (!s) throw new UserError(`no system matches "${input}". Try the full name or a J-number.`);
  return s;
}

function rootFor(ctx: BotContext, i: ChatInputCommandInteraction, chain: Chain, optionName: string): number[] {
  const given = i.options.getString(optionName);
  if (given) return [resolveSystem(ctx, given).id];
  if (ctx.homes.length) return ctx.homes;
  const biggest = components(chain)[0];
  if (!biggest?.length) throw new UserError(`${empty.map} (No HOME_SYSTEMS configured either.)`);
  return [biggest[0]!];
}

async function reply(i: ChatInputCommandInteraction, ctx: BotContext, spec: {
  title: string; url?: string | null; colour: number; lines: string[]; chain?: Chain;
}): Promise<void> {
  const embeds = embedsFromLines({
    title: spec.title,
    url: spec.url ?? null,
    colour: spec.colour,
    lines: spec.lines,
    footer: source(ctx, spec.chain),
    authorIcon: ctx.avatarUrl,
  });
  await sendEmbeds(i, embeds);
}

function avoidSet(ctx: BotContext, guildId: string | null): ReadonlySet<number> {
  return new Set(guildId ? ctx.prefs.get(guildId).avoid : []);
}

function homeName(ctx: BotContext): string | null {
  const id = ctx.homes[0];
  return id ? ctx.universe.systems.get(id)?.name ?? null : null;
}

/** Resolve "from"/"to" text into a state, defaulting from to the best home. */
function planState(ctx: BotContext, chain: Chain, fromText: string | null, toText: string): RouteState {
  let fromArg = fromText?.trim() || null;
  let toArg = toText.trim();
  // "Jita to Rens", "Jita > Rens", "Jita -> Rens" typed into one box fills both.
  const PAIR = /^(.+?)\s*(?:>|->|→|\s+to\s+)\s*(.+)$/i;
  const pairIn = (t: string | null) => (t ? PAIR.exec(t) : null);
  const p = pairIn(toArg) ?? pairIn(fromArg);
  if (p && (!fromArg || !toArg || /^home$/i.test(fromArg) || pairIn(fromArg))) {
    fromArg = p[1]!.trim();
    toArg = p[2]!.trim();
  }
  const to = resolveSystem(ctx, toArg);
  let from: number;
  if (fromArg && !/^home$/i.test(fromArg)) from = resolveSystem(ctx, fromArg).id;
  else {
    const homes = ctx.homes.length ? ctx.homes : (components(chain)[0]?.slice(0, 1) ?? []);
    if (!homes.length) throw new UserError(`${empty.map} (No HOME_SYSTEMS configured either.)`);
    from = homes.length === 1 ? homes[0]! : homes
      .map((f) => ({ f, r: shortestPath(chain, f, to.id) }))
      .sort((a, b) => (a.r?.length ?? Infinity) - (b.r?.length ?? Infinity))[0]!.f;
  }
  return defaultState(from, to.id);
}

/** /chain, /exits, /eol, /unknown, /activity are one panel opened on a tab. */
async function panel(i: ChatInputCommandInteraction, ctx: BotContext, tab: Tab): Promise<void> {
  const chain = await ctx.store.get(FRESH_MS);
  const given = i.options.getString('from');
  const root = given ? resolveSystem(ctx, given).id : null;
  if (!root && !ctx.homes.length && !chain.adj.size) throw new UserError(`${empty.map} (No HOME_SYSTEMS configured either.)`);
  const out = await renderPanel(ctx, chain, { tab, root });
  await i.editReply({ embeds: out.embeds, components: out.components });
}

async function route(i: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const chain = await ctx.store.get(FRESH_MS);
  const st = planState(ctx, chain, i.options.getString('from', true), i.options.getString('to', true));
  const out = renderRouteReply(st, chain, opts(ctx), avoidSet(ctx, i.guildId), source(ctx, chain), ctx.avatarUrl, await ctx.scout.holes());
  await i.editReply({ embeds: out.embeds, components: out.components });
}

/** The form's submit: same reply as the command. */
export async function handleRouteModal(i: ModalSubmitInteraction, ctx: BotContext): Promise<void> {
  const quiet = ctx.config.ephemeral;
  await i.deferReply(quiet ? { flags: MessageFlags.Ephemeral } : {});
  try {
    const chain = await ctx.store.get(FRESH_MS);
    const st = planState(ctx, chain, i.fields.getTextInputValue('from'), i.fields.getTextInputValue('to'));
    const out = renderRouteReply(st, chain, opts(ctx), avoidSet(ctx, i.guildId), source(ctx, chain), ctx.avatarUrl, await ctx.scout.holes());
    await i.editReply({ embeds: out.embeds, components: out.components });
  } catch (e) {
    const known = e instanceof UserError || e instanceof TripwireError;
    if (!known) console.error(e);
    const hint = e instanceof UserError && /no system matches "(.+?)"/.exec(e.message);
    const suggestions = hint ? searchSystems(ctx.universe, hint[1]!, 5).map((s) => s.name) : [];
    await i.editReply({ content: regrets(known ? e.message : 'something went wrong; the log has the details.') + (suggestions.length ? `\nDid you mean: ${suggestions.join(', ')}?` : '') });
  }
}

/** Buttons and the ship select under a route: recompute with the new state and edit in place. */
export async function handleRouteComponent(i: ButtonInteraction | StringSelectMenuInteraction, ctx: BotContext): Promise<void> {
  const parsed = stateFromInteraction(i);
  if (!parsed) return;
  let { state: st } = parsed;
  if (parsed.action === 'edit') {
    const name = (id: number) => ctx.universe.systems.get(id)?.name ?? '';
    await i.showModal(routeModal(homeName(ctx), name(st.from), name(st.to)));
    return;
  }
  if (parsed.action === 'home') {
    const home = ctx.homes[0];
    if (home) st = { ...st, from: home };
  }
  // "Route here" buttons (…|go) answer in a new message; the rest edit in place.
  const fresh = parsed.action === 'go';
  if (fresh) await i.deferReply(ctx.config.ephemeral ? { flags: MessageFlags.Ephemeral } : {});
  else await i.deferUpdate();
  const chain = await ctx.store.get(FRESH_MS);
  const out = renderRouteReply(st, chain, opts(ctx), avoidSet(ctx, i.guildId), source(ctx, chain), ctx.avatarUrl, await ctx.scout.holes());
  await i.editReply({ embeds: out.embeds, components: out.components });
}

/** The sigs view for one system, with a system switcher, Notes and Route buttons. */
export async function sigsRender(ctx: BotContext, chain: Chain, sysId: number): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] }> {
  const s = ctx.universe.systems.get(sysId);
  if (!s) throw new UserError(`unknown system #${sysId}`);
  const list = chain.sigsBySystem.get(s.id) ?? [];
  const o = opts(ctx);
  const lines = [systemHeadline(o, s), '', ...(list.length ? renderSigs(list, s.id, chain, o) : [`*${empty.sigs(s.name)}*`])];
  const embeds = embedsFromLines({ title: `${list.length} signature${list.length === 1 ? '' : 's'} in ${s.name}`, url: systemUrl(o, s.name), colour: COLOUR.mustard, lines, footer: source(ctx, chain), authorIcon: ctx.avatarUrl });
  // Switcher: home first, then the chain in walking order, then the rest of the map.
  const order: number[] = [];
  const seen = new Set<number>();
  for (const h of ctx.homes) for (const id of treeSystems(spanningTree(chain, h))) if (!seen.has(id)) { seen.add(id); order.push(id); }
  for (const id of chain.adj.keys()) if (!seen.has(id)) { seen.add(id); order.push(id); }
  const options = order.slice(0, 25).map((id) => {
    const sys = ctx.universe.systems.get(id);
    const n = chain.sigsBySystem.get(id)?.length ?? 0;
    return { label: sys?.name ?? String(id), value: String(id), description: `${n} sig${n === 1 ? '' : 's'}${ctx.homes.includes(id) ? ' · home' : ''}`, default: id === s.id };
  });
  const home = ctx.homes[0];
  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`sg|${s.id}|refresh`).setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`sg|${s.id}|notes`).setLabel('Notes').setEmoji('📝').setStyle(ButtonStyle.Secondary),
      ...(home && home !== s.id ? [new ButtonBuilder().setCustomId(`${encodeState(defaultState(home, s.id))}|go`).setLabel('Route here').setEmoji('🧭').setStyle(ButtonStyle.Secondary)] : []),
    ),
  ];
  if (options.length > 1) rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(`sg|${s.id}|switch`).setPlaceholder('Another system on the map…').addOptions(options)));
  return { embeds, components: rows };
}

async function sigs(i: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const chain = await ctx.store.get(FRESH_MS);
  const s = resolveSystem(ctx, i.options.getString('system', true));
  await i.editReply(await sigsRender(ctx, chain, s.id));
}

/** sg|<system>|switch|refresh|notes|new */
export async function handleSigsComponent(i: ButtonInteraction | StringSelectMenuInteraction, ctx: BotContext): Promise<void> {
  const [, sysRaw, action] = i.customId.split('|');
  let sysId = Number(sysRaw);
  if (i.isStringSelectMenu()) sysId = Number(i.values[0]);
  if (action === 'notes') {
    await i.deferReply(ctx.config.ephemeral ? { flags: MessageFlags.Ephemeral } : {});
    await notesReply(i, ctx, ctx.universe.systems.get(sysId) ?? null, null);
    return;
  }
  if (action === 'new') await i.deferReply(ctx.config.ephemeral ? { flags: MessageFlags.Ephemeral } : {});
  else await i.deferUpdate();
  const chain = action === 'refresh' ? await ctx.store.refresh().catch(() => ctx.store.get(0)) : await ctx.store.get(FRESH_MS);
  await i.editReply(await sigsRender(ctx, chain, sysId));
}

async function notes(i: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  let systemArg = i.options.getString('system')?.trim() || null;
  let find = i.options.getString('find')?.trim() || null;
  const prefixed = systemArg && /^(?:find|search|text)\s*[:=]\s*(.+)$/i.exec(systemArg);
  if (prefixed) {
    find = find ?? prefixed[1]!.trim();
    systemArg = null;
  }
  if (!systemArg && !find) throw new UserError('give me a system, or something to find, or both.');
  let s = systemArg ? findSystem(ctx.universe, systemArg) ?? null : null;
  let preface: string | null = null;
  if (systemArg && !s) {
    if (find) throw new UserError(`no system matches "${systemArg}". Try the full name or a J-number.`);
    preface = `*No system is called “${systemArg}”, so Trippy searched the notes for it instead.*`;
    find = systemArg;
    s = null;
  }
  await notesReply(i, ctx, s, find, preface);
}

/** Notes on a system and/or matching text, with a Search button (and Sigs when a system is set). */
async function notesReply(i: { editReply: ChatInputCommandInteraction['editReply'] }, ctx: BotContext, s: SystemInfo | null, find: string | null, preface: string | null = null): Promise<void> {
  const o = opts(ctx);
  const all = (await ctx.tripwire.comments(s?.id)).sort((x, y) => y.modifiedAt.getTime() - x.modifiedAt.getTime());
  const needle = find?.toLowerCase();
  const plain = new Map(all.map((c) => [c.id, htmlToMarkdown(c.text)] as const));
  const list = needle ? all.filter((c) => plain.get(c.id)!.toLowerCase().includes(needle)) : all;
  const now = new Date();
  const lines: string[] = [];
  if (preface) lines.push(preface, '');
  if (s) lines.push(systemHeadline(o, s), '');
  if (!list.length) {
    lines.push(`*${needle ? `No note mentions “${find}”${s ? ` in ${s.name}` : ''}. Trippy has checked twice.` : empty.notes(s?.name ?? 'that')}*`);
  }
  for (const c of list.slice(0, 25)) {
    const where = s ? '' : `${systemLabel(o, c.systemId)} · `;
    const who = c.modifiedBy || c.createdBy || 'unknown';
    lines.push(`${where}**${who}** · ${ago(c.modifiedAt, now)}`);
    lines.push(`> ${highlight(plain.get(c.id) ?? '', find ?? undefined).replace(/\n/g, '\n> ').slice(0, 900)}`);
  }
  if (list.length > 25) lines.push(`*…and ${list.length - 25} more. Narrow the search.*`);
  const title = !list.length ? 'Notes'
    : needle ? `${list.length} note${list.length === 1 ? '' : 's'} mentioning “${find}”${s ? ` in ${s.name}` : ''}`
      : `${list.length} note${list.length === 1 ? '' : 's'} on ${s!.name}`;
  const embeds = embedsFromLines({ title, url: s ? systemUrl(o, s.name) : null, colour: COLOUR.teal, lines, footer: source(ctx), authorIcon: ctx.avatarUrl });
  const buttons = [new ButtonBuilder().setCustomId(`nt|search|${s?.id ?? 0}`).setLabel('Search').setEmoji('🔍').setStyle(ButtonStyle.Secondary)];
  if (s) buttons.push(new ButtonBuilder().setCustomId(`sg|${s.id}|new`).setLabel('Sigs').setEmoji('🛰️').setStyle(ButtonStyle.Secondary));
  await i.editReply({ embeds, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)] });
}

function highlight(text: string, needle: string | undefined): string {
  if (!needle) return text;
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
  return text.replace(re, (m) => `**${m}**`);
}

/** nt|search|<system>: open the search form, pre-filled with the system. */
export async function handleNotesComponent(i: ButtonInteraction, ctx: BotContext): Promise<void> {
  const sysId = Number(i.customId.split('|')[2]);
  await i.showModal(notesModal(sysId ? ctx.universe.systems.get(sysId)?.name ?? '' : ''));
}

export async function handleNotesModal(i: ModalSubmitInteraction, ctx: BotContext): Promise<void> {
  await i.deferReply(ctx.config.ephemeral ? { flags: MessageFlags.Ephemeral } : {});
  try {
    const find = i.fields.getTextInputValue('find').trim() || null;
    const sysText = i.fields.getTextInputValue('system').trim();
    const s = sysText ? resolveSystem(ctx, sysText) : null;
    if (!s && !find) throw new UserError('give me a system, or something to find, or both.');
    await notesReply(i, ctx, s, find);
  } catch (e) {
    const known = e instanceof UserError || e instanceof TripwireError;
    if (!known) console.error(e);
    await i.editReply({ content: regrets(known ? e.message : 'something went wrong; the log has the details.') });
  }
}

function guildOf(i: { guildId: string | null }): string {
  if (!i.guildId) throw new UserError('this list lives per server; use it in a server.');
  return i.guildId;
}

async function avoid(i: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const guildId = guildOf(i);
  const sub = i.options.getSubcommand();
  let headline: string | undefined;
  if (sub === 'add') {
    const s = resolveSystem(ctx, i.options.getString('system', true));
    headline = ctx.prefs.addAvoid(guildId, s.id) ? `Now avoiding **${s.name}**.` : `**${s.name}** was already avoided.`;
  } else if (sub === 'remove') {
    const s = resolveSystem(ctx, i.options.getString('system', true));
    headline = ctx.prefs.removeAvoid(guildId, s.id) ? `No longer avoiding **${s.name}**.` : `**${s.name}** was not on the list.`;
  } else if (sub === 'clear') {
    const n = ctx.prefs.clearAvoid(guildId);
    headline = n ? `Cleared ${n} system${n === 1 ? '' : 's'}.` : 'The list was already empty.';
  }
  await i.editReply(avoidPanel(ctx.prefs.get(guildId), opts(ctx), ctx.avatarUrl, headline));
}

/** av|add (form) · av|remove (select) · av|clear */
export async function handleAvoidComponent(i: ButtonInteraction | StringSelectMenuInteraction, ctx: BotContext): Promise<void> {
  const guildId = guildOf(i);
  const action = i.customId.split('|')[1];
  if (action === 'add') {
    await i.showModal(avoidModal());
    return;
  }
  await i.deferUpdate();
  let headline: string | undefined;
  if (i.isStringSelectMenu()) {
    const id = Number(i.values[0]);
    headline = ctx.prefs.removeAvoid(guildId, id) ? `No longer avoiding **${ctx.universe.systems.get(id)?.name ?? id}**.` : undefined;
  } else if (action === 'clear') {
    const n = ctx.prefs.clearAvoid(guildId);
    headline = `Cleared ${n} system${n === 1 ? '' : 's'}.`;
  }
  await i.editReply(avoidPanel(ctx.prefs.get(guildId), opts(ctx), ctx.avatarUrl, headline));
}

export async function handleAvoidModal(i: ModalSubmitInteraction, ctx: BotContext): Promise<void> {
  const guildId = guildOf(i);
  let headline: string;
  try {
    const s = resolveSystem(ctx, i.fields.getTextInputValue('system'));
    headline = ctx.prefs.addAvoid(guildId, s.id) ? `Now avoiding **${s.name}**.` : `**${s.name}** was already avoided.`;
  } catch (e) {
    headline = regrets(e instanceof UserError ? e.message : 'that did not work.');
  }
  const out = avoidPanel(ctx.prefs.get(guildId), opts(ctx), ctx.avatarUrl, headline);
  if (i.isFromMessage()) {
    await i.deferUpdate();
    await i.editReply(out);
  } else {
    await i.reply({ ...out, flags: MessageFlags.Ephemeral });
  }
}

function parsePlace(ctx: BotContext, raw: string): { systemId: number | null; region: string | null; label: string } {
  const m = /^region:(.+)$/i.exec(raw.trim());
  const regions = () => [...new Set([...ctx.universe.systems.values()].map((s) => s.region))];
  if (m) {
    const want = m[1]!.trim().toLowerCase();
    const region = regions().find((r) => r.toLowerCase() === want);
    if (!region) throw new UserError(`no region called "${m[1]}".`);
    return { systemId: null, region, label: `${region} (region)` };
  }
  const s = findSystem(ctx.universe, raw);
  if (s) return { systemId: s.id, region: null, label: s.name };
  const region = regions().find((r) => r.toLowerCase() === raw.trim().toLowerCase());
  if (region) return { systemId: null, region, label: `${region} (region)` };
  throw new UserError(`no system or region matches "${raw}".`);
}

function addWatch(ctx: BotContext, guildId: string, raw: string, gatesRaw: number | null): string {
  const p = parsePlace(ctx, raw);
  const gates = p.systemId ? (gatesRaw ?? 5) : 0;
  const added = ctx.prefs.addWatch(guildId, { systemId: p.systemId, region: p.region, gates });
  return `${added ? 'Now watching' : 'Updated'} **${p.label}**${p.systemId ? ` within ${gates} gate${gates === 1 ? '' : 's'}` : ''}.`;
}

async function watch(i: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const guildId = guildOf(i);
  const sub = i.options.getSubcommand();
  let headline: string | undefined;
  if (sub === 'add') headline = addWatch(ctx, guildId, i.options.getString('place', true), i.options.getInteger('gates'));
  else if (sub === 'remove') {
    const p = parsePlace(ctx, i.options.getString('place', true));
    headline = ctx.prefs.removeWatch(guildId, p.systemId, p.region) ? `No longer watching **${p.label}**.` : `**${p.label}** was not being watched.`;
  }
  await i.editReply(watchPanel(ctx.prefs.get(guildId), opts(ctx), ctx.avatarUrl, headline));
}

/** wt|add (form) · wt|remove (select) */
export async function handleWatchComponent(i: ButtonInteraction | StringSelectMenuInteraction, ctx: BotContext): Promise<void> {
  const guildId = guildOf(i);
  if (i.customId.split('|')[1] === 'add') {
    await i.showModal(watchModal());
    return;
  }
  await i.deferUpdate();
  let headline: string | undefined;
  if (i.isStringSelectMenu()) {
    const v = i.values[0] ?? '';
    const systemId = v.startsWith('s:') ? Number(v.slice(2)) : null;
    const region = v.startsWith('r:') ? v.slice(2) : null;
    if (ctx.prefs.removeWatch(guildId, systemId, region)) headline = `No longer watching **${systemId ? ctx.universe.systems.get(systemId)?.name ?? systemId : region}**.`;
  }
  await i.editReply(watchPanel(ctx.prefs.get(guildId), opts(ctx), ctx.avatarUrl, headline));
}

export async function handleWatchModal(i: ModalSubmitInteraction, ctx: BotContext): Promise<void> {
  const guildId = guildOf(i);
  let headline: string;
  try {
    const gatesText = i.fields.getTextInputValue('gates').trim();
    const gates = gatesText ? Number(gatesText) : null;
    if (gates !== null && !(Number.isInteger(gates) && gates >= 0 && gates <= 20)) throw new UserError('gates must be a whole number from 0 to 20.');
    headline = addWatch(ctx, guildId, i.fields.getTextInputValue('place'), gates);
  } catch (e) {
    headline = regrets(e instanceof UserError ? e.message : 'that did not work.');
  }
  const out = watchPanel(ctx.prefs.get(guildId), opts(ctx), ctx.avatarUrl, headline);
  if (i.isFromMessage()) {
    await i.deferUpdate();
    await i.editReply(out);
  } else {
    await i.reply({ ...out, flags: MessageFlags.Ephemeral });
  }
}

function alertHeadline(kind: AlertKind, on: boolean): string {
  return `${ALERT_INFO[kind].emoji} **${ALERT_INFO[kind].label}** alerts are now **${on ? 'on' : 'off'}**.`;
}

/** /alerts [kind] [state]: the panel, after applying a switch if one was asked for. */
async function alerts(i: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const kind = i.options.getString('kind') as AlertKind | null;
  const state = i.options.getString('state');
  let headline: string | undefined;
  if (kind && (ALERT_KINDS as readonly string[]).includes(kind)) {
    const on = ctx.prefs.setAlert(kind, state ? state === 'on' : !ctx.prefs.alertOn(kind));
    headline = alertHeadline(kind, on);
  }
  await i.editReply(alertsPanel(ctx.prefs.alerts(), ctx.avatarUrl, headline));
}

/** al|<kind>: flip that toggle and redraw. */
export async function handleAlertsComponent(i: ButtonInteraction, ctx: BotContext): Promise<void> {
  const kind = i.customId.split('|')[1] as AlertKind;
  if (!(ALERT_KINDS as readonly string[]).includes(kind)) return;
  await i.deferUpdate();
  const on = ctx.prefs.setAlert(kind, !ctx.prefs.alertOn(kind));
  await i.editReply(alertsPanel(ctx.prefs.alerts(), ctx.avatarUrl, alertHeadline(kind, on)));
}

async function near(i: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const chain = await ctx.store.get(FRESH_MS);
  const s = resolveSystem(ctx, i.options.getString('system', true));
  const o = opts(ctx);
  const found = nearestMapped(chain, ctx.universe, s.id, 5, 30);
  const lines = found.length
    ? found.map((r) => {
      const path = r.path.slice(0, -1).map((id) => ctx.universe.systems.get(id)?.name ?? `#${id}`);
      const via = r.gates === 0 ? 'you are on the map' : `${r.gates} gate${r.gates === 1 ? '' : 's'}${path.length ? ` via ${path.join(' → ')}` : ''}`;
      return `└ ${systemLabel(o, r.system)} · ${via} · chain of ${r.fragmentSize}`;
    })
    : [`*Nothing mapped within 30 gates of ${s.name}. The chains are elsewhere today.*`];
  const embeds = embedsFromLines({ title: `Nearest chains to ${s.name}`, url: systemUrl(o, s.name), colour: COLOUR.teal, lines: [systemHeadline(o, s), '', ...lines], footer: source(ctx, chain), authorIcon: ctx.avatarUrl });
  const buttons = found.filter((r) => r.gates > 0).slice(0, 5).map((r) =>
    new ButtonBuilder().setCustomId(`${encodeState(defaultState(s.id, r.system))}|go`).setLabel(`→ ${ctx.universe.systems.get(r.system)?.name ?? r.system} · ${r.gates}j`).setStyle(ButtonStyle.Secondary));
  await i.editReply({ embeds, components: buttons.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)] : [] });
}

async function wanted(i: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const guildId = i.guildId;
  if (!guildId) throw new UserError('the wanted list lives per server; use this in a server.');
  const sub = i.options.getSubcommand();
  const o = opts(ctx);
  const chain = await ctx.store.get(FRESH_MS);
  let headline: string;
  if (sub === 'add') {
    const s = resolveSystem(ctx, i.options.getString('system', true));
    const onMap = chain.adj.has(s.id);
    const dm = i.options.getBoolean('dm') ?? false;
    const fresh = ctx.prefs.addWanted(guildId, s.id, i.user.id, onMap, dm);
    const how = dm ? 'by direct message' : 'in the alert channel';
    headline = onMap
      ? `**${s.name}** is on the map right now — see \`/sigs ${s.name}\`. ${fresh ? `It stays on the list; Trippy will tell you ${how} the next time it turns up after leaving.` : 'Added you to the people waiting for it.'}`
      : fresh
        ? `Watching for **${s.name}**. Trippy will tell you ${how} the moment a hole to it lands on the map.`
        : `**${s.name}** was already on the list; added you to the people waiting for it (${how}).`;
  } else if (sub === 'remove') {
    const s = resolveSystem(ctx, i.options.getString('system', true));
    headline = ctx.prefs.removeWanted(guildId, s.id) ? `No longer waiting for **${s.name}**.` : `**${s.name}** was not on the list.`;
  } else {
    headline = 'Systems this server is waiting to see connected:';
  }
  const items = ctx.prefs.get(guildId).wanted.map((w) =>
    `└ ${systemLabel(o, w.systemId)} · ${w.onMap ? '**on the map now**' : 'not on the map'} · for ${[...w.userIds.map((id) => `<@${id}>`), ...(w.dmUserIds ?? []).map((id) => `<@${id}> (DM)`)].join(', ')} · since ${ago(new Date(w.addedAt), new Date())}`);
  await reply(i, ctx, { title: '🎯 Wanted', colour: COLOUR.amber, lines: [headline, '', ...(items.length ? items : ['*Nothing yet. `/wanted add J101507` and Trippy will tell you when it shows up.*'])], chain });
}

async function kills(i: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const guildId = i.guildId;
  if (!guildId) throw new UserError('kill watches live per server; use this in a server.');
  const sub = i.options.getSubcommand();
  const o = opts(ctx);
  let headline: string;
  if (sub === 'watch') {
    const s = resolveSystem(ctx, i.options.getString('system', true));
    const dm = i.options.getBoolean('dm') ?? false;
    const fresh = ctx.prefs.addKillWatch(guildId, s.id, i.user.id, dm);
    const how = dm ? 'by direct message' : 'in the alert channel';
    const feed = ctx.killWatch ? '' : ' (the kill feed is off on this Trippy, so nothing will arrive until it is switched on)';
    headline = fresh
      ? `Watching **${s.name}** for kills. Every kill zKillboard files there reaches you ${how}${feed}.`
      : `**${s.name}** was already watched; added you to the people who hear about it (${how}).`;
  } else if (sub === 'unwatch') {
    const s = resolveSystem(ctx, i.options.getString('system', true));
    headline = ctx.prefs.removeKillWatch(guildId, s.id) ? `No longer watching **${s.name}** for kills.` : `**${s.name}** was not being watched.`;
  } else {
    headline = 'Systems this server hears every kill in:';
  }
  const items = ctx.prefs.get(guildId).kills.map((k) =>
    `└ ${systemLabel(o, k.systemId)} · for ${[...k.userIds.map((id) => `<@${id}>`), ...k.dmUserIds.map((id) => `<@${id}> (DM)`)].join(', ')} · since ${ago(new Date(k.addedAt), new Date())}`);
  await reply(i, ctx, { title: '💥 Kill watches', colour: COLOUR.red, lines: [headline, '', ...(items.length ? items : ['*Nothing yet. `/kills watch Rens` and every kill there is announced, mapped or not.*'])] });
}

async function status(i: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const store = ctx.store;
  const chain = store.latest;
  const now = new Date();
  const o = opts(ctx);
  const homes = ctx.homes.length ? ctx.homes.map((h) => systemLabel(o, h)).join(', ') : '*(none configured)*';
  const missingHomes = ctx.config.homeSystems.filter((name) => !findSystem(ctx.universe, name));
  const embed = new EmbedBuilder()
    .setAuthor({ name: AUTHOR, ...(ctx.avatarUrl ? { iconURL: ctx.avatarUrl } : {}) })
    .setTitle(store.lastError ? 'Trippy is unwell' : 'Trippy is on duty')
    .setURL(ctx.config.tripwire.url)
    .setColor(store.lastError ? COLOUR.red : COLOUR.green)
    .addFields(
      { name: 'Tripwire', value: `[${ctx.config.tripwire.label}](${ctx.config.tripwire.url})\nmask \`${ctx.config.tripwire.maskId}\``, inline: true },
      { name: 'Home', value: homes + (missingHomes.length ? `\n⚠️ unknown: ${missingHomes.join(', ')}` : ''), inline: true },
      { name: 'Polling', value: `every ${ctx.config.pollSeconds}s · ${store.polls} polls\nup since ${ago(ctx.startedAt, now)}`, inline: true },
    );
  if (chain) {
    const eolCount = [...chain.connections.values()].filter((c) => c.life === 'critical').length;
    embed.addFields({
      name: 'Map',
      value: `${chain.adj.size} systems · ${chain.connections.size} connections (${eolCount} EOL) · ${chain.signatures.size} signatures\nfetched ${ago(chain.fetchedAt, now)}${chain.skipped.length ? ` · ${chain.skipped.length} dangling wormhole rows ignored` : ''}`,
    });
  } else {
    embed.addFields({ name: 'Map', value: 'No successful poll yet.' });
  }
  if (store.lastError) {
    embed.addFields({ name: 'Last error', value: `${store.lastError.message}\n${store.lastErrorAt ? ago(store.lastErrorAt, now) : ''}` });
  }
  const toggles = ctx.prefs.alerts();
  const muted = ALERT_KINDS.filter((k) => !toggles[k]).map((k) => ALERT_INFO[k].label.toLowerCase());
  embed.addFields({
    name: 'Alerts',
    value: `${ctx.config.discord.alertChannelId ? `<#${ctx.config.discord.alertChannelId}>` : 'off (DISCORD_ALERT_CHANNEL_ID not set)'}\n${muted.length ? `🔕 off: ${muted.join(', ')}` : '🔔 every kind on'} · \`/alerts\``,
    inline: true,
  });
  const kw = ctx.killWatch?.health();
  if (kw) {
    const icon = kw.state === 'listening' ? '🟢' : kw.state === 'stalled' ? '🟠' : kw.state === 'erring' ? '🔴' : '⚫';
    embed.addFields({
      name: 'Kill feed',
      value: `${icon} ${kw.state} (${ctx.config.killAlerts}) · ${kw.seen} seen · ${kw.announced} announced\nlast kill on the wire ${kw.lastKill ? ago(kw.lastKill, now) : 'never'} · last announced ${kw.lastAnnounced ? ago(kw.lastAnnounced, now) : 'never'}${kw.error ? `\n⚠️ ${kw.error}` : ''}`,
      inline: true,
    });
  } else {
    embed.addFields({ name: 'Kill feed', value: '⚫ off', inline: true });
  }
  const scoutHoles = await ctx.scout.holes();
  embed.addFields({ name: 'EVE-Scout', value: ctx.scout.lastError ? `⚠️ ${ctx.scout.lastError}` : `${scoutHoles.length} Thera/Turnur holes`, inline: true });
  const gate = [
    ctx.config.allowedRoleIds.length ? `roles: ${ctx.config.allowedRoleIds.map((r) => `<@&${r}>`).join(' ')}` : null,
    ctx.config.allowedChannelIds.length ? `channels: ${ctx.config.allowedChannelIds.map((c) => `<#${c}>`).join(' ')}` : null,
  ].filter(Boolean).join('\n');
  embed.addFields({ name: 'Access', value: gate || '⚠️ open to everyone in the server (set ALLOWED_ROLE_IDS)', inline: true });
  embed.setFooter({ text: `universe ${ctx.universe.generatedAt.slice(0, 10)} · ${ctx.universe.systems.size} systems · ${ctx.universe.holes.size} hole types` });
  await i.editReply({ embeds: [embed] });
}

export { nameLink };
