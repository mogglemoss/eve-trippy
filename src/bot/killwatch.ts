/**
 * Watches the zKillboard feed and announces kills that happen in systems on
 * the map. The cursor is saved so a restart resumes rather than skipping.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Client } from 'discord.js';
import type { Chain } from '../chain/graph.js';
import type { RenderOpts } from '../chain/render.js';
import type { Esi } from '../esi.js';
import { R2z2 } from '../kills/r2z2.js';
import type { Kill } from '../kills/types.js';
import type { Logger } from '../log.js';
import { isKSpace, isRealSystemId, type Universe } from '../universe/index.js';
import { buildKillEmbed, type KillContext } from './kills.js';
import type { PrefsStore } from './prefs.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { defaultState, encodeState } from './routeUi.js';
import type { ChainStore } from './store.js';

export interface KillWatchOptions {
  client: Client;
  channelId: string;
  store: ChainStore;
  universe: Universe;
  esi: Esi;
  homes: number[];
  tripwireUrl: string;
  friendlyCorps: Set<number>;
  friendlyAlliances: Set<number>;
  /** 'jspace': only wormhole-space systems on the map; 'all': every mapped system. */
  scope: 'jspace' | 'all';
  /** Per-server kill watches: systems announced regardless of map or space. */
  prefs?: PrefsStore;
  /** The /alerts toggle: the feed keeps walking, nothing is posted while it says no. */
  enabled: () => boolean;
  cursorFile: string;
  log: Logger;
  avatarUrl: () => string | null;
}

export class KillWatch {
  readonly feed: R2z2;
  announced = 0;
  seen = 0;
  lastAnnouncedAt: Date | null = null;
  /** Every kill the feed has shown us in the last 24 hours, by system — ESI has no J-space kill data, this does. */
  private readonly bySystem = new Map<number, { id: number; time: number; value: number; npc: boolean }[]>();
  startedAt: Date | null = null;
  private readonly recent = new Set<number>();
  private lastSaved = 0;
  private healthTimer: NodeJS.Timeout | null = null;
  private warnedStall = false;

  constructor(private readonly o: KillWatchOptions) {
    this.feed = new R2z2({ log: (m) => o.log.info(m) });
  }

  start(): void {
    this.startedAt = new Date();
    const from = this.loadCursor();
    void this.feed.run((kill, seq) => this.onKill(kill, seq), from);
    this.healthTimer = setInterval(() => this.checkHealth(), 60_000);
    this.healthTimer.unref?.();
  }

  stop(): void {
    this.feed.stop();
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.saveCursor(true);
  }

  /** A quiet feed looks exactly like a working one unless somebody says so. */
  private checkHealth(): void {
    const state = this.feed.state;
    if (state === 'stalled' && !this.warnedStall) {
      this.warnedStall = true;
      this.o.log.warn(`zKillboard feed has been silent for ${Math.round(this.feed.stallAfterMs / 60_000)} minutes (cursor ${this.feed.next}); global kills run seconds apart, so the wire is probably stuck`);
    } else if (state === 'listening' && this.warnedStall) {
      this.warnedStall = false;
      this.o.log.info('zKillboard feed is flowing again');
    }
  }

  /** One-line health for /status. */
  health(): { state: string; seen: number; announced: number; lastKill: Date | null; lastAnnounced: Date | null; cursor: number | null; error: string | null } {
    return {
      state: this.feed.state,
      seen: this.seen,
      announced: this.announced,
      lastKill: this.feed.lastAt ? new Date(this.feed.lastAt) : null,
      lastAnnounced: this.lastAnnouncedAt,
      cursor: this.feed.next,
      error: this.feed.lastError,
    };
  }

  /** Systems worth announcing: the current map plus home, J-space only unless scope is 'all'. */
  private watched(chain: Chain | null): Set<number> {
    const s = new Set<number>();
    const consider = (id: number) => {
      if (this.o.scope === 'all') return s.add(id);
      const cls = this.o.universe.systems.get(id)?.cls;
      if (cls && !isKSpace(cls)) s.add(id);
    };
    for (const id of this.o.homes) consider(id);
    if (chain) for (const id of chain.adj.keys()) consider(id);
    return s;
  }

  /** Kills in `systemId` within the last `windowMs`, newest first. */
  kills(systemId: number, windowMs: number): { id: number; time: number; value: number; npc: boolean }[] {
    const since = Date.now() - windowMs;
    return (this.bySystem.get(systemId) ?? []).filter((k) => k.time >= since).sort((a, b) => b.time - a.time);
  }

  private remember(kill: Kill): void {
    const list = this.bySystem.get(kill.systemId) ?? [];
    list.push({ id: kill.id, time: kill.time.getTime(), value: kill.totalValue, npc: kill.npc });
    const cutoff = Date.now() - 24 * 3600_000;
    this.bySystem.set(kill.systemId, list.filter((k) => k.time >= cutoff));
  }

  private async onKill(kill: Kill, seq: number): Promise<void> {
    this.seen += 1;
    this.remember(kill);
    this.saveCursor();
    const chain = this.o.store.latest;
    if (!isRealSystemId(kill.systemId)) return;
    // Explicit /kills watches fire regardless of the map, the space, or the alert switch.
    const watches = this.o.prefs?.killWatchesFor(kill.systemId) ?? [];
    const onMap = this.watched(chain).has(kill.systemId) && this.o.enabled();
    if (!onMap && !watches.length) return;
    if (this.recent.has(kill.id)) return;
    this.recent.add(kill.id);
    if (this.recent.size > 500) this.recent.delete(this.recent.values().next().value!);

    const opts: RenderOpts = { universe: this.o.universe, now: new Date(), home: new Set(this.o.homes), tripwireUrl: this.o.tripwireUrl, md: true };
    const ctx: KillContext = {
      chain: chain ?? emptyChain(),
      opts,
      esi: this.o.esi,
      homes: this.o.homes,
      friendlyCorps: this.o.friendlyCorps,
      friendlyAlliances: this.o.friendlyAlliances,
      avatarUrl: this.o.avatarUrl(),
    };
    const embed = await buildKillEmbed(kill, ctx);
    const home = this.o.homes[0];
    const components = home && home !== kill.systemId
      ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${encodeState(defaultState(home, kill.systemId))}|go`).setLabel('Route there').setEmoji('🧭').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`${encodeState(defaultState(kill.systemId, home))}|go`).setLabel('Route home from there').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`sg|${kill.systemId}|new`).setLabel('Sigs').setEmoji('🛰️').setStyle(ButtonStyle.Secondary),
      )]
      : [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`sg|${kill.systemId}|new`).setLabel('Sigs').setEmoji('🛰️').setStyle(ButtonStyle.Secondary))];

    // Channel: once, whether it is on the map or somebody watches it; ping the watchers who asked for the channel.
    const channelPings = [...new Set(watches.flatMap((w) => w.k.userIds))];
    if (onMap || channelPings.length) {
      const channel = await this.o.client.channels.fetch(this.o.channelId);
      if (!channel?.isSendable()) {
        this.o.log.warn(`kill channel ${this.o.channelId} is not a text channel I can send to`);
      } else {
        await channel.send({ ...(channelPings.length ? { content: channelPings.map((id) => `<@${id}>`).join(' ') } : {}), embeds: [embed], components });
      }
    }
    // Direct messages to the watchers who asked for one. Buttons stay out of DMs; they need the server.
    for (const id of [...new Set(watches.flatMap((w) => w.k.dmUserIds))]) {
      try {
        const user = await this.o.client.users.fetch(id);
        await user.send({ embeds: [embed] });
      } catch (e) {
        this.o.log.warn(`could not DM kill to ${id}: ${(e as Error).message}`);
      }
    }
    this.announced += 1;
    this.lastAnnouncedAt = new Date();
    this.o.log.info(`kill ${kill.id} in ${this.o.universe.systems.get(kill.systemId)?.name ?? kill.systemId} announced (seq ${seq})`);
  }

  private loadCursor(): number | null {
    try {
      if (!existsSync(this.o.cursorFile)) return null;
      const { next } = JSON.parse(readFileSync(this.o.cursorFile, 'utf8')) as { next?: number };
      return typeof next === 'number' ? next : null;
    } catch {
      return null;
    }
  }

  private saveCursor(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastSaved < 30_000) return;
    if (this.feed.next === null) return;
    this.lastSaved = now;
    try {
      mkdirSync(dirname(this.o.cursorFile), { recursive: true });
      writeFileSync(`${this.o.cursorFile}.tmp`, JSON.stringify({ next: this.feed.next, savedAt: new Date().toISOString() }));
      renameSync(`${this.o.cursorFile}.tmp`, this.o.cursorFile);
    } catch {
      // best effort
    }
  }
}

function emptyChain(): Chain {
  return { fetchedAt: new Date(0), signatures: new Map(), sigsBySystem: new Map(), connections: new Map(), adj: new Map(), skipped: [] };
}
