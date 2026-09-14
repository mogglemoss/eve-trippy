/**
 * Polls Tripwire, keeps the latest chain, and announces what changed.
 *
 * The compact connection state is written to disk after every poll so a
 * restart picks up where it left off instead of re-announcing every hole.
 * A first run with no state file baselines silently.
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildChain, type Chain } from '../chain/graph.js';
import { diffChain, stateOf, type ChainEvent, type WatchState } from '../chain/diff.js';
import type { Logger } from '../log.js';
import type { TripwireClient } from '../tripwire/client.js';
import { isGhost } from '../chain/ghosts.js';
import type { Universe } from '../universe/index.js';

export interface StoreOptions {
  pollMs: number;
  stateFile: string;
  log: Logger;
  universe?: Universe;
}

interface StateFile {
  version: 1;
  savedAt: string;
  tripwireUrl: string;
  maskId: string;
  connections: WatchState;
}

export interface StoreEvents {
  events: [events: ChainEvent[], chain: Chain];
  refresh: [chain: Chain];
  failure: [error: Error];
}

export class ChainStore extends EventEmitter<StoreEvents> {
  latest: Chain | null = null;
  lastError: Error | null = null;
  lastErrorAt: Date | null = null;
  polls = 0;
  private state: WatchState | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<Chain> | null = null;

  constructor(private readonly tripwire: TripwireClient, private readonly opts: StoreOptions) {
    super();
  }

  start(): void {
    if (this.timer) return;
    void this.refresh().catch(() => {});
    this.timer = setInterval(() => void this.refresh().catch(() => {}), this.opts.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The latest chain if it is younger than `maxAgeMs`, else a fresh one (falling back to stale on failure). */
  async get(maxAgeMs: number): Promise<Chain> {
    if (this.latest && Date.now() - this.latest.fetchedAt.getTime() <= maxAgeMs) return this.latest;
    try {
      return await this.refresh();
    } catch (e) {
      if (this.latest) return this.latest;
      throw e;
    }
  }

  refresh(): Promise<Chain> {
    if (!this.inflight) {
      this.inflight = this.doRefresh().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async doRefresh(): Promise<Chain> {
    try {
      const chain = buildChain(await this.tripwire.snapshot());
      this.polls += 1;
      const prev = this.state ?? this.loadState();
      const u = this.opts.universe;
      const events = (prev ? diffChain(prev, chain) : []).map((e) => (u && e.kind === 'connected' && isGhost(e.c, u) ? { kind: 'ghost' as const, c: e.c } : e));
      this.state = stateOf(chain);
      this.saveState();
      this.latest = chain;
      this.lastError = null;
      if (!prev) this.opts.log.info(`baselined ${chain.connections.size} connections; changes from here on will be announced`);
      if (chain.skipped.length) this.opts.log.warn(`${chain.skipped.length} wormhole rows reference signatures not in the mask; ignored`);
      if (events.length) this.emit('events', events, chain);
      this.emit('refresh', chain);
      return chain;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.lastError = err;
      this.lastErrorAt = new Date();
      this.opts.log.warn(`poll failed: ${err.message}`);
      this.emit('failure', err);
      throw err;
    }
  }

  private loadState(): WatchState | null {
    const path = this.opts.stateFile;
    if (!existsSync(path)) return null;
    try {
      const file = JSON.parse(readFileSync(path, 'utf8')) as Partial<StateFile>;
      if (file.version !== 1 || !file.connections) return null;
      if (file.tripwireUrl !== this.tripwire.url || file.maskId !== this.tripwire.maskId) {
        this.opts.log.warn(`state file was for ${file.tripwireUrl} mask ${file.maskId}; starting fresh`);
        return null;
      }
      return file.connections;
    } catch (e) {
      this.opts.log.warn(`could not read ${path}: ${(e as Error).message}; starting fresh`);
      return null;
    }
  }

  private saveState(): void {
    if (!this.state) return;
    const path = this.opts.stateFile;
    const file: StateFile = {
      version: 1,
      savedAt: new Date().toISOString(),
      tripwireUrl: this.tripwire.url,
      maskId: this.tripwire.maskId,
      connections: this.state,
    };
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(file));
      renameSync(tmp, path);
    } catch (e) {
      this.opts.log.warn(`could not write ${path}: ${(e as Error).message}`);
    }
  }
}
