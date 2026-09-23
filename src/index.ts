import { Client, Events, GatewayIntentBits } from 'discord.js';
import { alertKindOf, buildAlertEmbeds, buildUnknownEmbed, buildWantedEmbed, filterAlertEvents } from './bot/alerts.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { defaultState, encodeState } from './bot/routeUi.js';
import { ghostReport } from './chain/ghosts.js';
import {
  denied, handleAlertsComponent, handleAutocomplete, handleAvoidComponent, handleAvoidModal, handleCommand, handleNotesComponent, handleNotesModal,
  handleRouteComponent, handleRouteModal, handleSigsComponent, handleWatchComponent, handleWatchModal, type BotContext,
} from './bot/commands.js';
import { handlePanelComponent } from './bot/panel.js';
import { PrefsStore } from './bot/prefs.js';
import { Esi } from './esi.js';
import { KillWatch } from './bot/killwatch.js';
import { EveScout } from './scout.js';
import { ChainStore } from './bot/store.js';
import { dirname, join } from 'node:path';
import { ConfigError, loadConfig, loadDotEnv } from './config.js';
import { log } from './log.js';
import { TripwireClient } from './tripwire/client.js';
import { findSystem, loadUniverse } from './universe/index.js';

loadDotEnv();
let config;
try {
  config = loadConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    log.error(e.message);
    process.exit(2);
  }
  throw e;
}

const universe = loadUniverse();
log.info(`universe: ${universe.systems.size} systems, ${universe.holes.size} hole types (built ${universe.generatedAt.slice(0, 10)})`);

const homes: number[] = [];
for (const name of config.homeSystems) {
  const s = findSystem(universe, name);
  if (s) homes.push(s.id);
  else log.warn(`HOME_SYSTEMS entry "${name}" matches no system; ignoring`);
}

const tripwire = new TripwireClient(config.tripwire);
// One state file per Tripwire host, so swapping between dev and production never re-announces a map.
const host = new URL(config.tripwire.url).host.replace(/[^a-z0-9.-]/gi, '_');
const stateFile = config.stateFile.replace(/(\.json)?$/, `.${host}.json`);
const store = new ChainStore(tripwire, { pollMs: config.pollSeconds * 1000, stateFile, log, universe });
const prefs = new PrefsStore(join(dirname(config.stateFile), 'prefs.json'));
const esi = new Esi();
const scout = new EveScout();
const ctx: BotContext = { config, universe, tripwire, store, homes, startedAt: new Date(), avatarUrl: null, prefs, esi, scout, killWatch: null };

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let killWatch: KillWatch | null = null;
const source = config.tripwire.label;

client.once(Events.ClientReady, (ready) => {
  ctx.avatarUrl = ready.user.displayAvatarURL({ size: 128 });
  log.info(`logged in as ${ready.user.tag}; watching ${config.tripwire.url} mask ${config.tripwire.maskId} every ${config.pollSeconds}s`);
  store.on('events', (events, chain) => {
    log.info(`${events.length} chain event(s): ${events.map((e) => e.kind).join(', ')}`);
    const channelId = config.discord.alertChannelId;
    if (!channelId) return;
    const ropts = { universe, now: new Date(), home: new Set(homes), tripwireUrl: config.tripwire.url, md: true };
    const posting = filterAlertEvents(events, prefs.alerts(), ropts, prefs.allWatches());
    const ghosts = prefs.alertOn('ghost') && events.some((e) => e.kind === 'ghost');
    if (!posting.length && !ghosts) {
      const held = new Map<string, number>();
      for (const e of events) held.set(alertKindOf(e, ropts), (held.get(alertKindOf(e, ropts)) ?? 0) + 1);
      log.info(`held back, off in /alerts: ${[...held].map(([k, n]) => `${n} ${k}`).join(', ')}`);
      return;
    }
    void (async () => {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isSendable()) {
          log.warn(`alert channel ${channelId} is not a text channel I can send to`);
          return;
        }
        const embeds = buildAlertEmbeds(posting, chain, ropts, source, ctx.avatarUrl, prefs.allWatches());
        if (ghosts) embeds.push(buildUnknownEmbed(ghostReport(chain, universe), ropts, ctx.avatarUrl));
        for (const embed of embeds) await channel.send({ embeds: [embed] });
      } catch (e) {
        log.error(`could not post alert: ${(e as Error).message}`);
      }
    })();
  });
  // Wanted systems: fire once each time one appears on the map.
  store.on('refresh', (chain) => {
    const appeared = prefs.markWanted(new Set(chain.adj.keys()));
    const channelId = config.discord.alertChannelId;
    if (!appeared.length) return;
    if (!prefs.alertOn('wanted')) {
      log.info(`wanted: ${appeared.length} system(s) appeared, alerts for that are switched off (/alerts)`);
      return;
    }
    void (async () => {
      try {
        const channel = channelId ? await client.channels.fetch(channelId) : null;
        const ropts = { universe, now: new Date(), home: new Set(homes), tripwireUrl: config.tripwire.url, md: true };
        for (const { w } of appeared) {
          const everyone = [...w.userIds, ...(w.dmUserIds ?? [])];
          const embed = buildWantedEmbed(w.systemId, everyone, chain, ropts, homes, ctx.avatarUrl);
          const home = homes[0];
          const components = home && home !== w.systemId
            ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setCustomId(`${encodeState(defaultState(home, w.systemId))}|go`).setLabel('Route there').setEmoji('🧭').setStyle(ButtonStyle.Secondary))]
            : [];
          const name = universe.systems.get(w.systemId)?.name ?? String(w.systemId);
          if (w.userIds.length && channel?.isSendable()) {
            await channel.send({ content: w.userIds.map((id) => `<@${id}>`).join(' '), embeds: [embed], components });
          }
          for (const id of w.dmUserIds ?? []) {
            try {
              await (await client.users.fetch(id)).send({ embeds: [embed], components });
            } catch (e) {
              log.warn(`wanted: could not DM ${id} about ${name}: ${(e as Error).message}`);
            }
          }
          log.info(`wanted: ${name} appeared; ${w.userIds.length} pinged in channel, ${(w.dmUserIds ?? []).length} by DM`);
        }
      } catch (e) {
        log.error(`could not post wanted alert: ${(e as Error).message}`);
      }
    })();
  });
  store.start();

  const killChannel = config.discord.killChannelId ?? config.discord.alertChannelId;
  if (config.killAlerts !== 'off' && killChannel) {
    const friendlyCorps = new Set(config.friendlyIds.filter((id) => id >= 98_000_000 && id < 99_000_000));
    const friendlyAlliances = new Set(config.friendlyIds.filter((id) => id >= 99_000_000));
    const maskCorp = /^(\d+)\.2$/.exec(config.tripwire.maskId);
    if (maskCorp) friendlyCorps.add(Number(maskCorp[1]));
    killWatch = new KillWatch({
      client, channelId: killChannel, store, universe, esi, homes,
      tripwireUrl: config.tripwire.url, friendlyCorps, friendlyAlliances, scope: config.killAlerts, prefs,
      enabled: () => prefs.alertOn('kills'),
      cursorFile: join(dirname(config.stateFile), 'kills.json'), log,
      avatarUrl: () => ctx.avatarUrl,
    });
    ctx.killWatch = killWatch;
    killWatch.start();
    log.info(`kill alerts on (${config.killAlerts}): zKillboard feed → channel ${killChannel}; friendly corps ${[...friendlyCorps].join(',') || '-'} alliances ${[...friendlyAlliances].join(',') || '-'}`);
  } else {
    log.info('kill alerts off');
  }
});

client.on(Events.InteractionCreate, (interaction) => {
  if (interaction.isChatInputCommand()) void handleCommand(interaction, ctx);
  else if (interaction.isAutocomplete()) void handleAutocomplete(interaction, ctx).catch((e) => log.warn(`autocomplete failed: ${(e as Error).message}`));
  else if (interaction.isModalSubmit()) {
    if (denied(interaction, ctx)) return;
    const fail = (what: string) => (e: Error) => log.warn(`${what} form failed: ${e.message}`);
    if (interaction.customId === 'rtm') void handleRouteModal(interaction, ctx).catch(fail('route'));
    else if (interaction.customId === 'avm') void handleAvoidModal(interaction, ctx).catch(fail('avoid'));
    else if (interaction.customId === 'wtm') void handleWatchModal(interaction, ctx).catch(fail('watch'));
    else if (interaction.customId === 'ntm') void handleNotesModal(interaction, ctx).catch(fail('notes'));
  }
  else if (interaction.isButton() || interaction.isStringSelectMenu()) {
    if (denied(interaction, ctx)) return;
    const id = interaction.customId;
    const fail = (what: string) => (e: Error) => log.warn(`${what} control failed: ${e.message}`);
    if (id.startsWith('cp|')) void handlePanelComponent(interaction, ctx).catch(fail('panel'));
    else if (id.startsWith('rt|')) void handleRouteComponent(interaction, ctx).catch(fail('route'));
    else if (id.startsWith('sg|')) void handleSigsComponent(interaction, ctx).catch(fail('sigs'));
    else if (id.startsWith('av|')) void handleAvoidComponent(interaction, ctx).catch(fail('avoid'));
    else if (id.startsWith('wt|')) void handleWatchComponent(interaction, ctx).catch(fail('watch'));
    else if (id.startsWith('al|') && interaction.isButton()) void handleAlertsComponent(interaction, ctx).catch(fail('alerts'));
    else if (id.startsWith('nt|') && interaction.isButton()) void handleNotesComponent(interaction, ctx).catch(fail('notes'));
  }
});

client.on(Events.Error, (e) => log.error(`discord: ${e.message}`));

const shutdown = (signal: string) => {
  log.info(`${signal}: shutting down`);
  store.stop();
  killWatch?.stop();
  void client.destroy();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await client.login(config.discord.token);
