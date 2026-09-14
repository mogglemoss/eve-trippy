/**
 * The avoid list and the watch list as small panels: a select to remove an
 * entry, an Add button that opens a form, and the current entries.
 * customIds: `av|remove` `av|add` `av|clear` · `wt|remove` `wt|add` · `al|<kind>`.
 */
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { systemLabel, type RenderOpts } from '../chain/render.js';
import { ALERT_INFO, ALERT_KINDS, type AlertToggles, type GuildPrefs } from './prefs.js';
import { AUTHOR, COLOUR } from './voice.js';

export interface ListRender {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
}

function base(title: string, colour: number, avatarUrl: string | null): EmbedBuilder {
  return new EmbedBuilder().setAuthor({ name: AUTHOR, ...(avatarUrl ? { iconURL: avatarUrl } : {}) }).setTitle(title).setColor(colour);
}

export function avoidPanel(prefs: GuildPrefs, opts: RenderOpts, avatarUrl: string | null, headline?: string): ListRender {
  const u = opts.universe;
  const items = prefs.avoid.map((id) => `└ ${systemLabel(opts, id)}`);
  const embed = base('🚫 Avoid list', COLOUR.teal, avatarUrl)
    .setDescription([headline, headline ? '' : null, 'Systems `/route` steers around, except at a route\'s ends. Toggle it per route with the 🚫 button.', '', ...(items.length ? items : ['*Nothing. Trippy goes where it is pointed.*'])].filter((x) => x !== null).join('\n'));
  const rows: ListRender['components'] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('av|add').setLabel('Add a system').setEmoji('➕').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('av|clear').setLabel('Clear all').setEmoji('🗑️').setStyle(ButtonStyle.Danger).setDisabled(!prefs.avoid.length),
    ),
  ];
  if (prefs.avoid.length) {
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId('av|remove').setPlaceholder('Remove…').addOptions(
        prefs.avoid.slice(0, 25).map((id) => ({ label: u.systems.get(id)?.name ?? String(id), value: String(id), emoji: '➖' })),
      ),
    ));
  }
  return { embeds: [embed], components: rows };
}

export function avoidModal(): ModalBuilder {
  return new ModalBuilder().setCustomId('avm').setTitle('Avoid a system').addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('system').setLabel('System').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('name or J-number').setMaxLength(40),
    ),
  );
}

export function watchPanel(prefs: GuildPrefs, opts: RenderOpts, avatarUrl: string | null, headline?: string): ListRender {
  const items = prefs.watches.map((w) => w.systemId
    ? `└ ${systemLabel(opts, w.systemId)} · within ${w.gates} gate${w.gates === 1 ? '' : 's'}`
    : `└ **${w.region}** (region)`);
  const embed = base('📍 Watch list', COLOUR.blue, avatarUrl)
    .setDescription([headline, headline ? '' : null, 'A new exit near one of these gets a 📍 line in the chain alert.', '', ...(items.length ? items : ['*Nothing yet. Add a system with a gate radius, or a region.*'])].filter((x) => x !== null).join('\n'));
  const rows: ListRender['components'] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('wt|add').setLabel('Add a place').setEmoji('➕').setStyle(ButtonStyle.Primary),
    ),
  ];
  if (prefs.watches.length) {
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId('wt|remove').setPlaceholder('Remove…').addOptions(
        prefs.watches.slice(0, 25).map((w) => ({
          label: w.systemId ? `${opts.universe.systems.get(w.systemId)?.name ?? w.systemId} · ${w.gates} gates` : `${w.region} (region)`,
          value: w.systemId ? `s:${w.systemId}` : `r:${w.region}`,
          emoji: '➖',
        })),
      ),
    ));
  }
  return { embeds: [embed], components: rows };
}

export function watchModal(): ModalBuilder {
  return new ModalBuilder().setCustomId('wtm').setTitle('Watch a place').addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('place').setLabel('System or region').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Jita, or The Forge').setMaxLength(60),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('gates').setLabel('Within this many gates (systems only)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('5').setMaxLength(2),
    ),
  );
}

/** Every alert kind with its switch; buttons toggle in place. Map-wide, not per server. */
export function alertsPanel(toggles: AlertToggles, avatarUrl: string | null, headline?: string): ListRender {
  const items = ALERT_KINDS.map((k) => `${toggles[k] ? '🔔' : '🔕'} ${ALERT_INFO[k].emoji} **${ALERT_INFO[k].label}** — ${ALERT_INFO[k].blurb}`);
  const embed = base('🔔 Alerts', COLOUR.amber, avatarUrl)
    .setDescription([headline, headline ? '' : null, 'What Trippy posts in the alert channel. One map, one setting: this is not per server. Click a kind to switch it.', '', ...items].filter((x) => x !== null).join('\n'));
  const buttons = ALERT_KINDS.map((k) =>
    new ButtonBuilder().setCustomId(`al|${k}`).setLabel(ALERT_INFO[k].label).setEmoji(ALERT_INFO[k].emoji).setStyle(toggles[k] ? ButtonStyle.Success : ButtonStyle.Secondary));
  const rows: ListRender['components'] = [];
  for (let i = 0; i < buttons.length; i += 4) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(i, i + 4)));
  return { embeds: [embed], components: rows };
}

export function notesModal(systemName = ''): ModalBuilder {
  return new ModalBuilder().setCustomId('ntm').setTitle('Search the notes').addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('find').setLabel('Text to find').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('any words; blank = all notes on the system').setMaxLength(80),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('system').setLabel('Only in this system (optional)').setStyle(TextInputStyle.Short).setRequired(false).setValue(systemName).setMaxLength(40),
    ),
  );
}
