/**
 * A fake Discord: enough of discord.js's interaction surface to drive every
 * command and control without a gateway, capturing what the bot would send.
 * Used by the offline command tests and the live e2e suites alike.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AutocompleteInteraction, ButtonInteraction, ChatInputCommandInteraction, ModalSubmitInteraction, StringSelectMenuInteraction,
} from 'discord.js';
import type { BotContext } from '../src/bot/commands.js';
import { PrefsStore } from '../src/bot/prefs.js';
import { ChainStore } from '../src/bot/store.js';
import { loadConfig } from '../src/config.js';
import type { Esi } from '../src/esi.js';
import { silentLog } from '../src/log.js';
import type { EveScout } from '../src/scout.js';
import type { TripwireClient } from '../src/tripwire/client.js';
import type { Comment, Snapshot } from '../src/tripwire/types.js';
import { loadUniverse, type Universe } from '../src/universe/index.js';

export interface Sent {
  kind: 'defer' | 'deferUpdate' | 'reply' | 'edit' | 'followUp' | 'update' | 'modal' | 'autocomplete';
  payload: any;
}

export interface FakeInteraction {
  sent: Sent[];
  guildId: string | null;
  channelId: string;
  user: { id: string };
  member: { roles: string[] };
  commandName: string;
  customId: string;
  values: string[];
  options: {
    getString: (n: string, required?: boolean) => string | null;
    getInteger: (n: string) => number | null;
    getBoolean: (n: string) => boolean | null;
    getSubcommand: () => string;
    getFocused: (full?: boolean) => any;
  };
  fields: { getTextInputValue: (n: string) => string };
  isStringSelectMenu: () => boolean;
  isButton: () => boolean;
  isFromMessage: () => boolean;
  deferReply: (o?: any) => Promise<void>;
  deferUpdate: () => Promise<void>;
  reply: (p: any) => Promise<void>;
  editReply: (p: any) => Promise<void>;
  followUp: (p: any) => Promise<void>;
  update: (p: any) => Promise<void>;
  showModal: (m: any) => Promise<void>;
  respond: (c: any) => Promise<void>;
}

export interface Fake {
  command?: string;
  sub?: string;
  strings?: Record<string, string>;
  ints?: Record<string, number>;
  bools?: Record<string, boolean>;
  focused?: { name: string; value: string };
  customId?: string;
  values?: string[];
  fields?: Record<string, string>;
  guildId?: string | null;
  channelId?: string;
  roles?: string[];
  kind?: 'button' | 'select' | 'modal' | 'command' | 'autocomplete';
}

export function fakeInteraction(f: Fake = {}): FakeInteraction {
  const sent: Sent[] = [];
  const push = (kind: Sent['kind']) => async (payload: any) => { sent.push({ kind, payload: payload && typeof payload.toJSON === 'function' ? payload.toJSON() : payload }); };
  return {
    sent,
    guildId: f.guildId === undefined ? 'guild-1' : f.guildId,
    channelId: f.channelId ?? 'chan-1',
    user: { id: 'user-1' },
    member: { roles: f.roles ?? [] },
    commandName: f.command ?? '',
    customId: f.customId ?? '',
    values: f.values ?? [],
    options: {
      getString: (n) => f.strings?.[n] ?? null,
      getInteger: (n) => f.ints?.[n] ?? null,
      getBoolean: (n) => f.bools?.[n] ?? null,
      getSubcommand: () => f.sub ?? '',
      getFocused: () => f.focused ?? { name: 'system', value: '' },
    },
    fields: { getTextInputValue: (n) => f.fields?.[n] ?? '' },
    isStringSelectMenu: () => f.kind === 'select',
    isButton: () => f.kind === 'button',
    isFromMessage: () => true,
    deferReply: push('defer'),
    deferUpdate: push('deferUpdate'),
    reply: push('reply'),
    editReply: push('edit'),
    followUp: push('followUp'),
    update: push('update'),
    showModal: push('modal'),
    respond: push('autocomplete'),
  };
}

export const asCommand = (i: FakeInteraction) => i as unknown as ChatInputCommandInteraction;
export const asButton = (i: FakeInteraction) => i as unknown as ButtonInteraction;
export const asSelect = (i: FakeInteraction) => i as unknown as StringSelectMenuInteraction;
export const asModal = (i: FakeInteraction) => i as unknown as ModalSubmitInteraction;
export const asAutocomplete = (i: FakeInteraction) => i as unknown as AutocompleteInteraction;

/** A context wired to a snapshot instead of a live Tripwire. */
export async function fakeContext(snapshot: Snapshot, comments: Comment[] = [], env: Record<string, string> = {}, universe?: Universe): Promise<BotContext> {
  const dir = mkdtempSync(join(tmpdir(), 'trippy-'));
  const config = loadConfig({
    DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: '1', DISCORD_GUILD_ID: 'guild-1', DISCORD_ALERT_CHANNEL_ID: 'chan-1',
    TRIPWIRE_URL: 'https://tw.example.test', TRIPWIRE_USERNAME: 'u', TRIPWIRE_PASSWORD: 'p', TRIPWIRE_MASK_ID: '98000001.2',
    TRIPWIRE_LABEL: 'Tripwire test', HOME_SYSTEMS: env.HOME_SYSTEMS ?? 'J100001', STATE_FILE: join(dir, 'state.json'), ...env,
  });
  const u = universe ?? loadUniverse();
  const tripwire = {
    url: config.tripwire.url, maskId: config.tripwire.maskId,
    snapshot: async () => snapshot,
    comments: async (systemId?: number) => comments.filter((c) => !systemId || c.systemId === systemId),
  } as unknown as TripwireClient;
  const store = new ChainStore(tripwire, { pollMs: 60_000, stateFile: config.stateFile, log: silentLog, universe: u });
  await store.refresh();
  const esi = {
    resolveNames: async () => new Map(), name: (_id: number, fb = 'unknown') => fb,
    corp: async () => null, alliance: async () => null,
    systemActivity: async () => new Map([[30000142, { shipKills: 3, podKills: 1, npcKills: 40, jumps: 900 }]]),
  } as unknown as Esi;
  const scout = { holes: async () => [], lastError: null } as unknown as EveScout;
  const homes = config.homeSystems.map((n) => [...u.byName.values()].find((s) => s.name.toLowerCase() === n.toLowerCase())?.id).filter((x): x is number => typeof x === 'number');
  return { config, universe: u, tripwire, store, homes, startedAt: new Date(), avatarUrl: null, prefs: new PrefsStore(join(dir, 'prefs.json')), esi, scout, killWatch: null };
}

// ---------------------------------------------------------------------------
// Discord's limits, so a reply that would be rejected fails here first.
// ---------------------------------------------------------------------------

const len = (s: unknown) => (typeof s === 'string' ? s.length : 0);

export function checkMessage(payload: any, where = 'message'): void {
  const embeds: any[] = (payload?.embeds ?? []).map((e: any) => (typeof e?.toJSON === 'function' ? e.toJSON() : e));
  if (embeds.length > 10) throw new Error(`${where}: ${embeds.length} embeds (max 10)`);
  let total = 0;
  embeds.forEach((e, n) => {
    const w = `${where} embed[${n}]`;
    if (len(e.title) > 256) throw new Error(`${w}: title ${len(e.title)} > 256`);
    if (len(e.description) > 4096) throw new Error(`${w}: description ${len(e.description)} > 4096`);
    if ((e.fields ?? []).length > 25) throw new Error(`${w}: ${e.fields.length} fields > 25`);
    for (const f of e.fields ?? []) {
      if (len(f.name) > 256 || !len(f.name)) throw new Error(`${w}: field name length ${len(f.name)}`);
      if (len(f.value) > 1024 || !len(f.value)) throw new Error(`${w}: field "${f.name}" value length ${len(f.value)}`);
    }
    if (len(e.footer?.text) > 2048) throw new Error(`${w}: footer too long`);
    if (len(e.author?.name) > 256) throw new Error(`${w}: author too long`);
    total += len(e.title) + len(e.description) + len(e.footer?.text) + len(e.author?.name) + (e.fields ?? []).reduce((a: number, f: any) => a + len(f.name) + len(f.value), 0);
  });
  if (total > 6000) throw new Error(`${where}: embeds total ${total} > 6000`);
  if (len(payload?.content) > 2000) throw new Error(`${where}: content > 2000`);
  const rows: any[] = (payload?.components ?? []).map((r: any) => (typeof r?.toJSON === 'function' ? r.toJSON() : r));
  if (rows.length > 5) throw new Error(`${where}: ${rows.length} action rows > 5`);
  rows.forEach((row, n) => {
    const comps: any[] = row.components ?? [];
    const w = `${where} row[${n}]`;
    const selects = comps.filter((c) => c.type === 3);
    const buttons = comps.filter((c) => c.type === 2);
    if (selects.length > 1 || (selects.length && buttons.length)) throw new Error(`${w}: a select must be alone in its row`);
    if (buttons.length > 5) throw new Error(`${w}: ${buttons.length} buttons > 5`);
    for (const c of comps) {
      if (len(c.custom_id) > 100) throw new Error(`${w}: custom_id "${c.custom_id}" > 100`);
      if (c.type === 2 && c.style !== 5 && !c.custom_id) throw new Error(`${w}: button without custom_id`);
      if (len(c.label) > 80) throw new Error(`${w}: label "${c.label}" > 80`);
      if (c.type === 3) {
        if (!c.options?.length || c.options.length > 25) throw new Error(`${w}: select with ${c.options?.length ?? 0} options`);
        for (const o of c.options) {
          if (len(o.label) > 100 || !len(o.label) || len(o.value) > 100 || len(o.description) > 100) throw new Error(`${w}: select option "${o.label}" too long`);
        }
        if (c.options.filter((o: any) => o.default).length > 1) throw new Error(`${w}: more than one default option`);
      }
    }
  });
}

/** Every clickable control in a payload, as fakes ready to hand to a handler. */
export function controls(payload: any): { kind: 'button' | 'select'; customId: string; values: string[]; label: string }[] {
  const rows: any[] = (payload?.components ?? []).map((r: any) => (typeof r?.toJSON === 'function' ? r.toJSON() : r));
  const out: { kind: 'button' | 'select'; customId: string; values: string[]; label: string }[] = [];
  for (const row of rows) for (const c of row.components ?? []) {
    if (c.type === 2 && !c.disabled && c.custom_id) out.push({ kind: 'button', customId: c.custom_id, values: [], label: c.label ?? '' });
    if (c.type === 3) out.push({ kind: 'select', customId: c.custom_id, values: [c.options[c.options.length - 1].value], label: c.placeholder ?? '' });
  }
  return out;
}

export function lastSent(i: FakeInteraction, kinds: Sent['kind'][] = ['edit', 'reply', 'update', 'followUp']): any {
  for (let n = i.sent.length - 1; n >= 0; n--) if (kinds.includes(i.sent[n]!.kind)) return i.sent[n]!.payload;
  return null;
}
