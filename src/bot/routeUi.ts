/**
 * The route reply: an embed with the steps and the settings in force, plus
 * message components to change them in place — Shorter / Safer / Less
 * secure, the skip toggles, the avoid list, and a ship-size select. Every
 * control's customId carries the whole state, so a click needs no session:
 * `rt|from|to|mode|flags|ship`.
 */
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
  type ButtonInteraction, type StringSelectMenuInteraction,
} from 'discord.js';
import type { Chain } from '../chain/graph.js';
import { routeChatLine, routeStrip, systemLabel, systemUrl, type RenderOpts } from '../chain/render.js';
import { findRoute, type Mode, type RoutePrefs, type ShipClass } from '../chain/route.js';
import type { ScoutHole } from '../scout.js';
import { AUTHOR, COLOUR, empty } from './voice.js';

export interface RouteState {
  from: number;
  to: number;
  mode: Mode;
  skipEol: boolean;
  skipCrit: boolean;
  skipReduced: boolean;
  /** Honour the server's avoid list. */
  useAvoid: boolean;
  /** Show the step list, avoid list and legend (off = compact, phone-sized). */
  details: boolean;
  minShip: ShipClass | null;
}

export const defaultState = (from: number, to: number): RouteState =>
  ({ from, to, mode: 'shortest', skipEol: false, skipCrit: false, skipReduced: false, useAvoid: true, details: false, minShip: null });

const MODE_CODE: Record<Mode, string> = { shortest: 's', safer: 'f', less_safe: 'u' };
const CODE_MODE: Record<string, Mode> = { s: 'shortest', f: 'safer', u: 'less_safe' };
const SHIP_CODE: Record<ShipClass, string> = { s: 's', m: 'm', l: 'l', xl: 'x' };
const CODE_SHIP: Record<string, ShipClass> = { s: 's', m: 'm', l: 'l', x: 'xl' };
const MODE_LABEL: Record<Mode, string> = { shortest: 'Shorter', safer: 'Safer', less_safe: 'Less secure' };
const MODE_ICON: Record<Mode, string> = { shortest: '🏃', safer: '🛡️', less_safe: '🔥' };
const SHIP_LABEL: Record<ShipClass, string> = { s: 'frigate and up', m: 'cruiser and up', l: 'battleship and up', xl: 'capital only' };

export function encodeState(st: RouteState): string {
  // 'n' marks the avoid list switched off (absent = on); 'd' marks details shown.
  const flags = `${st.skipEol ? 'e' : ''}${st.skipCrit ? 'c' : ''}${st.skipReduced ? 'r' : ''}${st.useAvoid ? '' : 'n'}${st.details ? 'd' : ''}` || '-';
  return `rt|${st.from}|${st.to}|${MODE_CODE[st.mode]}|${flags}|${st.minShip ? SHIP_CODE[st.minShip] : '-'}`;
}

export function decodeState(id: string): RouteState | null {
  const [tag, from, to, mode, flags, ship] = id.split('|');
  if (tag !== 'rt' || !from || !to || !mode || !flags || !ship) return null;
  return {
    from: Number(from), to: Number(to),
    mode: CODE_MODE[mode] ?? 'shortest',
    skipEol: flags.includes('e'), skipCrit: flags.includes('c'), skipReduced: flags.includes('r'),
    useAvoid: !flags.includes('n'),
    details: flags.includes('d'),
    minShip: CODE_SHIP[ship] ?? null,
  };
}

/** The form: From (blank = home) and To. `fromName`/`toName` pre-fill it when editing. */
export function routeModal(homeName: string | null, fromName = '', toName = ''): ModalBuilder {
  const from = new TextInputBuilder().setCustomId('from').setLabel('From').setStyle(TextInputStyle.Short).setRequired(false)
    .setPlaceholder(homeName ? `where you are, or blank for home (${homeName})` : 'where you are').setMaxLength(40);
  const to = new TextInputBuilder().setCustomId('to').setLabel('To').setStyle(TextInputStyle.Short).setRequired(true)
    .setPlaceholder('system name or J-number').setMaxLength(40);
  if (fromName) from.setValue(fromName);
  if (toName) to.setValue(toName);
  return new ModalBuilder().setCustomId('rtm').setTitle('Plan a route')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(from), new ActionRowBuilder<TextInputBuilder>().addComponents(to));
}

/** The customId of a control is the state *after* pressing it. Icon-only, so a phone fits a row of five. */
export function components(st: RouteState, avoidCount: number): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  const modeBtn = (mode: Mode) =>
    new ButtonBuilder()
      .setCustomId(encodeState({ ...st, mode }) + (st.mode === mode ? '|=' : ''))
      .setEmoji(MODE_ICON[mode])
      .setStyle(st.mode === mode ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(st.mode === mode);
  const toggle = (key: 'skipEol' | 'skipCrit' | 'skipReduced' | 'useAvoid' | 'details', emoji: string, disabled = false) =>
    new ButtonBuilder()
      .setCustomId(encodeState({ ...st, [key]: !st[key] }) + (disabled ? '|x' : ''))
      .setEmoji(emoji)
      .setStyle(st[key] ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(disabled);
  const nav = (suffix: string, emoji: string) =>
    new ButtonBuilder().setCustomId(`${encodeState(st)}|${suffix}`).setEmoji(emoji).setStyle(ButtonStyle.Secondary);
  const ship = new StringSelectMenuBuilder()
    .setCustomId(`${encodeState(st)}|ship`)
    .setPlaceholder(st.minShip ? `🌀 ${SHIP_LABEL[st.minShip]}` : '🌀 any hole')
    .addOptions(
      { label: 'Any hole', value: '-', emoji: '🌀', default: st.minShip === null },
      { label: 'Frigate-sized holes and up', value: 's', emoji: '🛶', description: '5m per jump', default: st.minShip === 's' },
      { label: 'Cruiser-sized and up', value: 'm', emoji: '⛵', description: '62m per jump', default: st.minShip === 'm' },
      { label: 'Battleship-sized and up', value: 'l', emoji: '🚢', description: '375m per jump', default: st.minShip === 'l' },
      { label: 'Capital-sized only', value: 'x', emoji: '🛳️', description: '1b+ per jump', default: st.minShip === 'xl' },
    );
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(modeBtn('shortest'), modeBtn('safer'), modeBtn('less_safe'), nav('swap', '🔁'), nav('edit', '✏️')),
    new ActionRowBuilder<ButtonBuilder>().addComponents(toggle('skipEol', '⏳'), toggle('skipCrit', '🔴'), toggle('skipReduced', '🟠'), toggle('useAvoid', '🚫', avoidCount === 0), toggle('details', '📜')),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(ship),
  ];
}

export interface RouteRender {
  embeds: EmbedBuilder[];
  components: ReturnType<typeof components>;
}

export function renderRouteReply(
  st: RouteState, chain: Chain, opts: RenderOpts, avoid: ReadonlySet<number>, footer: string, avatarUrl: string | null, scout: ScoutHole[] = [],
): RouteRender {
  const u = opts.universe;
  const effectiveAvoid = st.useAvoid ? avoid : new Set<number>();
  const prefs: RoutePrefs = { mode: st.mode, minShip: st.minShip, skipEol: st.skipEol, skipCrit: st.skipCrit, skipReduced: st.skipReduced, avoid: effectiveAvoid, scout };
  const route = findRoute(chain, u, st.from, st.to, prefs);
  const fromName = u.systems.get(st.from)?.name ?? `#${st.from}`;
  const toName = u.systems.get(st.to)?.name ?? `#${st.to}`;

  const embed = new EmbedBuilder()
    .setAuthor({ name: AUTHOR, ...(avatarUrl ? { iconURL: avatarUrl } : {}) })
    .setTitle(`${fromName} → ${toName}`)
    .setURL(systemUrl(opts, toName))
    .setColor(route ? COLOUR.amber : COLOUR.grey);

  const skips = [st.skipEol && '⏳', st.skipCrit && '🔴', st.skipReduced && '🟠'].filter(Boolean).join('');
  const settings = [
    `${MODE_ICON[st.mode]} ${MODE_LABEL[st.mode].toLowerCase()}`,
    `🌀 ${st.minShip ? SHIP_LABEL[st.minShip] : 'any'}`,
    skips ? `skip ${skips}` : null,
    avoid.size ? `🚫 ${st.useAvoid ? avoid.size : 'off'}` : null,
  ].filter(Boolean).join(' · ');

  const extraEmbeds: EmbedBuilder[] = [];
  if (!route) {
    embed.setDescription(`**No route.** Not by hole, not by gate, not with these settings.\n${chain.adj.has(st.to) ? 'It is on the map, but cut off.' : 'Somebody needs to scan.'}\n${settings}`);
  } else if (!route.jumps) {
    embed.setDescription(`${empty.route(toName)}\n${settings}`);
  } else {
    const parts = [`**${route.jumps} jump${route.jumps === 1 ? '' : 's'}**`];
    if (route.holes || route.gates) parts.push(`${route.holes} hole${route.holes === 1 ? '' : 's'} · ${route.gates} gate${route.gates === 1 ? '' : 's'}`);
    if (route.steps.some((s) => s.kind === 'scout')) parts.push('via EVE-Scout');
    const copy = routeChatLine(route, u);
    let strip = routeStrip(route, opts, st.details);
    if (strip.length > 3000) strip = routeStrip(route, opts, false); // a very long route falls back to the compact strip
    const budget = 3900 - parts.join(' · ').length - settings.length - strip.length;
    embed.setDescription(`${parts.join(' · ')}\n${strip}\n\`\`\`\n${copy.length > budget ? copy.slice(0, Math.max(0, budget - 10)) + '…' : copy}\n\`\`\`\n${settings}`);
  }
  if (st.details) {
    const avoidText = !avoid.size
      ? '*none set — `/avoid add`*'
      : !st.useAvoid
        ? `*off* · ${avoid.size} on the list`
        : [...avoid].slice(0, 12).map((id) => systemLabel(opts, id)).join(' · ') + (avoid.size > 12 ? ` · …and ${avoid.size - 12} more` : '');
    embed.addFields({ name: '🚫 Avoiding', value: avoidText });
  }
  const last = extraEmbeds[extraEmbeds.length - 1] ?? embed;
  last.setFooter({ text: footer });
  return { embeds: [embed, ...extraEmbeds], components: components(st, avoid.size) };
}

/** What a control asks for: a state change, or a navigation action. */
export function stateFromInteraction(i: ButtonInteraction | StringSelectMenuInteraction): { state: RouteState; action: 'update' | 'swap' | 'home' | 'edit' | 'go' } | null {
  const st = decodeState(i.customId);
  if (!st) return null;
  const suffix = i.customId.split('|')[6] ?? '';
  if (i.isStringSelectMenu()) {
    const v = i.values[0] ?? '-';
    st.minShip = CODE_SHIP[v] ?? null;
    return { state: st, action: 'update' };
  }
  if (suffix === 'swap') return { state: { ...st, from: st.to, to: st.from }, action: 'swap' };
  if (suffix === 'home') return { state: st, action: 'home' };
  if (suffix === 'edit') return { state: st, action: 'edit' };
  if (suffix === 'go') return { state: st, action: 'go' };
  return { state: st, action: 'update' };
}

