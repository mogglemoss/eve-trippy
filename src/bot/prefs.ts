/**
 * Preferences that outlive a restart: per-guild lists (avoid, watch, wanted)
 * and the map-wide alert toggles. Stored next to the watcher state as plain JSON.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Watch {
  /** A system ID, or a region name. */
  systemId: number | null;
  region: string | null;
  /** Announce a new exit within this many gates. */
  gates: number;
}

export interface Wanted {
  systemId: number;
  /** Discord user IDs to ping in the channel when it turns up. */
  userIds: string[];
  /** Discord user IDs to tell by direct message instead. */
  dmUserIds?: string[];
  addedAt: string;
  /** True while the system is on the map; the alert fires on the off→on edge. */
  onMap: boolean;
}

export interface GuildPrefs {
  /** System IDs to route around (never applied to a route's endpoints). */
  avoid: number[];
  /** Places to announce new exits near. */
  watches: Watch[];
  /** Systems people are waiting to see connected. */
  wanted: Wanted[];
}

/** Every kind of alert Trippy can post, each switchable on its own. */
export const ALERT_KINDS = ['connection', 'exit', 'identified', 'heavy', 'spent', 'ghost', 'wanted', 'kills'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export type AlertToggles = Record<AlertKind, boolean>;

/** What each kind is called in the panel, and what it covers. */
export const ALERT_INFO: Record<AlertKind, { label: string; emoji: string; blurb: string }> = {
  connection: { label: 'New connection', emoji: '🟢', blurb: 'a new hole between two wormhole systems' },
  exit: { label: 'New exit', emoji: '🚪', blurb: 'a new hole with a k-space or Thera end (📍 watch-list matches always post)' },
  identified: { label: 'Far side identified', emoji: '🔎', blurb: 'an unknown far side gets a system' },
  heavy: { label: 'A hole is getting heavy', emoji: '🟡', blurb: 'mass goes destabilised' },
  spent: { label: 'A hole is nearly spent', emoji: '🔴', blurb: 'mass goes critical' },
  ghost: { label: 'Unknown holes', emoji: '❓', blurb: 'ghosts to delete, unidentified holes to scan' },
  wanted: { label: 'Wanted system appeared', emoji: '🎯', blurb: 'pings the people on the /wanted list' },
  kills: { label: 'Kills', emoji: '💥', blurb: 'zKillboard kills in mapped systems (KILL_ALERTS sets the scope)' },
};

/**
 * Out of the box, chain chatter is off: a big nomadic map makes far too much of
 * it. Watches and wanted systems are explicit asks and stay on; so do ghosts and
 * kills. A corp that only maps its home chain can switch the rest on.
 */
export const ALERT_DEFAULTS: AlertToggles = {
  connection: false, exit: false, identified: false, heavy: false, spent: false, ghost: true, wanted: true, kills: true,
};

interface PrefsFile {
  version: 1;
  guilds: Record<string, GuildPrefs>;
  /** Map-wide: the alert channel is one channel, whoever is listening. Missing keys take the default. */
  alerts?: Partial<AlertToggles>;
}

export class PrefsStore {
  private data: PrefsFile = { version: 1, guilds: {} };

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      try {
        const file = JSON.parse(readFileSync(path, 'utf8')) as PrefsFile;
        if (file.version === 1 && file.guilds) this.data = file;
      } catch {
        // unreadable prefs are not worth crashing over; start empty
      }
    }
  }

  get(guildId: string): GuildPrefs {
    const p = this.data.guilds[guildId];
    return p ? { avoid: p.avoid ?? [], watches: p.watches ?? [], wanted: p.wanted ?? [] } : { avoid: [], watches: [], wanted: [] };
  }

  addAvoid(guildId: string, systemId: number): boolean {
    const p = this.get(guildId);
    if (p.avoid.includes(systemId)) return false;
    this.data.guilds[guildId] = { ...p, avoid: [...p.avoid, systemId] };
    this.save();
    return true;
  }

  removeAvoid(guildId: string, systemId: number): boolean {
    const p = this.get(guildId);
    if (!p.avoid.includes(systemId)) return false;
    this.data.guilds[guildId] = { ...p, avoid: p.avoid.filter((id) => id !== systemId) };
    this.save();
    return true;
  }

  clearAvoid(guildId: string): number {
    const p = this.get(guildId);
    this.data.guilds[guildId] = { ...p, avoid: [] };
    this.save();
    return p.avoid.length;
  }

  addWatch(guildId: string, w: Watch): boolean {
    const p = this.get(guildId);
    const same = p.watches.find((x) => x.systemId === w.systemId && x.region === w.region);
    const watches = same ? p.watches.map((x) => (x === same ? w : x)) : [...p.watches, w];
    this.data.guilds[guildId] = { ...p, watches };
    this.save();
    return !same;
  }

  removeWatch(guildId: string, systemId: number | null, region: string | null): boolean {
    const p = this.get(guildId);
    const watches = p.watches.filter((x) => !(x.systemId === systemId && x.region === region));
    if (watches.length === p.watches.length) return false;
    this.data.guilds[guildId] = { ...p, watches };
    this.save();
    return true;
  }

  /** Every guild's watches, for the alert path (one map, many servers). */
  allWatches(): Watch[] {
    return Object.values(this.data.guilds).flatMap((g) => g.watches ?? []);
  }

  /** Adds a wanted system for a user; returns whether the entry is new to the server. */
  addWanted(guildId: string, systemId: number, userId: string, onMapNow: boolean, dm = false): boolean {
    const p = this.get(guildId);
    const existing = p.wanted.find((w) => w.systemId === systemId);
    const put = (w: Wanted) => {
      w.userIds = w.userIds.filter((id) => id !== userId);
      w.dmUserIds = (w.dmUserIds ?? []).filter((id) => id !== userId);
      if (dm) w.dmUserIds.push(userId); else w.userIds.push(userId);
    };
    if (existing) {
      put(existing);
      this.data.guilds[guildId] = p;
      this.save();
      return false;
    }
    const w: Wanted = { systemId, userIds: [], dmUserIds: [], addedAt: new Date().toISOString(), onMap: onMapNow };
    put(w);
    this.data.guilds[guildId] = { ...p, wanted: [...p.wanted, w] };
    this.save();
    return true;
  }

  removeWanted(guildId: string, systemId: number): boolean {
    const p = this.get(guildId);
    const wanted = p.wanted.filter((w) => w.systemId !== systemId);
    if (wanted.length === p.wanted.length) return false;
    this.data.guilds[guildId] = { ...p, wanted };
    this.save();
    return true;
  }

  /** Every guild's wanted entries with their guild, for the alert path. */
  allWanted(): { guildId: string; w: Wanted }[] {
    return Object.entries(this.data.guilds).flatMap(([guildId, g]) => (g.wanted ?? []).map((w) => ({ guildId, w })));
  }

  /** Records whether a wanted system is on the map; returns the entries that just appeared. */
  markWanted(mapped: ReadonlySet<number>): { guildId: string; w: Wanted }[] {
    const appeared: { guildId: string; w: Wanted }[] = [];
    let changed = false;
    for (const [guildId, g] of Object.entries(this.data.guilds)) {
      for (const w of g.wanted ?? []) {
        const now = mapped.has(w.systemId);
        if (now && !w.onMap) appeared.push({ guildId, w });
        if (now !== w.onMap) { w.onMap = now; changed = true; }
      }
    }
    if (changed) this.save();
    return appeared;
  }

  /** The alert toggles with defaults filled in. */
  alerts(): AlertToggles {
    return { ...ALERT_DEFAULTS, ...(this.data.alerts ?? {}) };
  }

  alertOn(kind: AlertKind): boolean {
    return this.alerts()[kind];
  }

  /** Sets one toggle; returns the new state. */
  setAlert(kind: AlertKind, on: boolean): boolean {
    this.data.alerts = { ...(this.data.alerts ?? {}), [kind]: on };
    this.save();
    return on;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data));
      renameSync(`${this.path}.tmp`, this.path);
    } catch {
      // best effort
    }
  }
}
