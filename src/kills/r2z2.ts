/**
 * zKillboard's R2Z2 feed: killmails as they are processed, one JSON file per
 * strictly increasing sequence number.
 *
 *   GET https://r2z2.zkillboard.com/ephemeral/sequence.json   -> {"sequence": N}
 *   GET https://r2z2.zkillboard.com/ephemeral/{N}.json         -> killmail, or 404
 *
 * Rules from the wiki (https://github.com/zKillboard/zKillboard/wiki/API-(R2Z2)):
 * 15 requests/second/IP, a non-empty User-Agent, at least six seconds between
 * polls after a 404. Files live for at least 24 hours.
 *
 * Learned the hard way walking this feed elsewhere: sequence ids have permanent
 * holes (ids are handed out faster than files are filed), so a 404 at the
 * head is only "caught up" for a while — after that, look a few ids ahead.
 * And old killmails get reprocessed and ride the feed again, so anything
 * older than a few minutes is dropped rather than announced.
 */
import type { Kill } from './types.js';

const BASE = 'https://r2z2.zkillboard.com/ephemeral';
import { USER_AGENT as UA } from '../ua.js';

export interface R2z2File {
  killmail_id: number;
  hash: string;
  esi: {
    killmail_id: number;
    killmail_time: string;
    solar_system_id: number;
    victim: { character_id?: number; corporation_id?: number; alliance_id?: number; ship_type_id?: number };
    attackers: { character_id?: number; corporation_id?: number; alliance_id?: number; ship_type_id?: number; final_blow?: boolean }[];
  };
  zkb: { totalValue?: number; npc?: boolean; solo?: boolean; awox?: boolean; labels?: string[]; attackerCount?: number };
  uploaded_at: number;
  sequence_id: number;
}

export function toKill(f: R2z2File): Kill {
  const v = f.esi.victim ?? {};
  const attackers = f.esi.attackers ?? [];
  const fb = attackers.find((a) => a.final_blow) ?? null;
  const opt = (n: number | undefined) => (typeof n === 'number' ? n : null);
  return {
    id: f.killmail_id,
    hash: f.hash,
    time: new Date(f.esi.killmail_time),
    systemId: f.esi.solar_system_id,
    victim: { characterId: opt(v.character_id), corporationId: opt(v.corporation_id), allianceId: opt(v.alliance_id), shipTypeId: opt(v.ship_type_id) },
    attackers: f.zkb.attackerCount ?? attackers.length,
    finalBlow: fb ? { characterId: opt(fb.character_id), corporationId: opt(fb.corporation_id), allianceId: opt(fb.alliance_id), shipTypeId: opt(fb.ship_type_id) } : null,
    attackerCorps: new Set(attackers.map((a) => a.corporation_id).filter((x): x is number => typeof x === 'number')),
    attackerAlliances: new Set(attackers.map((a) => a.alliance_id).filter((x): x is number => typeof x === 'number')),
    attackerList: attackers.map((a) => ({ characterId: opt(a.character_id), corporationId: opt(a.corporation_id), allianceId: opt(a.alliance_id), shipTypeId: opt(a.ship_type_id) })),
    totalValue: f.zkb.totalValue ?? 0,
    npc: f.zkb.npc ?? false,
    solo: f.zkb.solo ?? false,
    awox: f.zkb.awox ?? false,
    labels: f.zkb.labels ?? [],
  };
}

export interface R2z2Options {
  fetchImpl?: typeof fetch;
  /** Pause after a 404 at the head. */
  idleMs?: number;
  /** Pause between consecutive successful fetches (stay well under 15/s). */
  stepMs?: number;
  /** How long the head may refuse before we look past it for a hole. */
  holePatienceMs?: number;
  /** Re-read sequence.json this often while idle; jump if we have fallen far behind. */
  resyncMs?: number;
  /** Drop killmails older than this (reprocessed mails ride the feed). */
  maxAgeMs?: number;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const HOLE_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12];
const FAR_BEHIND = 400;

export class R2z2 {
  private readonly fetchImpl: typeof fetch;
  private readonly idleMs: number;
  private readonly stepMs: number;
  private readonly holePatienceMs: number;
  private readonly resyncMs: number;
  private readonly maxAgeMs: number;
  private readonly log: (msg: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private running = false;
  /** The next sequence to fetch. */
  next: number | null = null;
  fetched = 0;
  skipped = 0;
  stale = 0;
  lastAt: number | null = null;
  lastError: string | null = null;
  startedAt: number | null = null;
  /** No killmail for this long means the wire is plugged in and hearing nothing. */
  stallAfterMs = 10 * 60_000;

  /** off | listening | stalled | erring — for /status and the stall warning. */
  get state(): 'off' | 'listening' | 'stalled' | 'erring' {
    if (!this.running) return 'off';
    if (this.lastError) return 'erring';
    const since = this.lastAt ?? this.startedAt ?? this.now();
    return this.now() - since > this.stallAfterMs ? 'stalled' : 'listening';
  }

  constructor(o: R2z2Options = {}) {
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.idleMs = o.idleMs ?? 6_500;
    this.stepMs = o.stepMs ?? 150;
    this.holePatienceMs = o.holePatienceMs ?? 20_000;
    this.resyncMs = o.resyncMs ?? 180_000;
    this.maxAgeMs = o.maxAgeMs ?? 10 * 60_000;
    this.log = o.log ?? (() => {});
    this.sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.now = o.now ?? (() => Date.now());
  }

  async latestSequence(): Promise<number> {
    const res = await this.fetchImpl(`${BASE}/sequence.json`, { headers: { 'User-Agent': UA }, cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`r2z2 sequence.json answered ${res.status}`);
    const { sequence } = (await res.json()) as { sequence: number };
    if (typeof sequence !== 'number') throw new Error('r2z2 sequence.json unreadable');
    return sequence;
  }

  /** null when the file is not there (404). */
  async fetchOne(seq: number): Promise<Kill | null> {
    const res = await this.fetchImpl(`${BASE}/${seq}.json`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`r2z2 ${seq}.json answered ${res.status}`);
    return toKill((await res.json()) as R2z2File);
  }

  /**
   * Runs until stop(): walks the sequence forward, calling onKill for every
   * fresh killmail. Starts at `from` (a saved cursor) when it is still inside
   * the retention window, else at the live head.
   */
  async run(onKill: (kill: Kill, seq: number) => Promise<void> | void, from?: number | null): Promise<void> {
    this.running = true;
    this.startedAt = this.now();
    let headRefusedSince: number | null = null;
    let lastResync = 0;

    const seed = async () => {
      const head = await this.latestSequence();
      // sequence.json only updates every 51 kills, so a cursor a little past it is normal.
      if (from && head - from < 20_000 && from - head < 200) {
        this.next = from;
        this.log(`r2z2: resuming at ${from} (${head - from} behind the head)`);
      } else {
        this.next = head + 1;
        this.log(`r2z2: starting at the head, sequence ${this.next}`);
      }
      lastResync = this.now();
    };

    const handle = async (kill: Kill, seq: number) => {
      this.fetched += 1;
      this.lastAt = this.now();
      this.next = seq + 1;
      headRefusedSince = null;
      if (this.now() - kill.time.getTime() > this.maxAgeMs) {
        this.stale += 1;
        return;
      }
      try {
        await onKill(kill, seq);
      } catch (e) {
        this.log(`r2z2: handler failed for kill ${kill.id}: ${(e as Error).message}`);
      }
    };

    while (this.running) {
      try {
        if (this.next === null) await seed();
        const seq = this.next!;
        const kill = await this.fetchOne(seq);
        this.lastError = null;
        if (kill) {
          await handle(kill, seq);
          await this.sleep(this.stepMs);
          continue;
        }

        // 404 at the head.
        headRefusedSince ??= this.now();
        const refusedFor = this.now() - headRefusedSince;

        if (refusedFor >= this.holePatienceMs) {
          // Probably a hole: look a few ids past it.
          let found = false;
          for (const step of HOLE_STEPS) {
            const probe = await this.fetchOne(seq + step);
            await this.sleep(this.stepMs);
            if (probe) {
              this.skipped += step;
              this.log(`r2z2: hole at ${seq}; skipped ${step} to ${seq + step}`);
              await handle(probe, seq + step);
              found = true;
              break;
            }
          }
          if (found) continue;
          headRefusedSince = this.now(); // reset the patience clock and keep waiting
        }

        if (this.now() - lastResync >= this.resyncMs) {
          lastResync = this.now();
          const head = await this.latestSequence();
          if (head - seq > FAR_BEHIND) {
            this.log(`r2z2: ${head - seq} behind the head; jumping to ${head + 1}`);
            this.skipped += head + 1 - seq;
            this.next = head + 1;
            headRefusedSince = null;
            continue;
          }
        }
        await this.sleep(this.idleMs);
      } catch (e) {
        this.lastError = (e as Error).message;
        this.log(`r2z2: ${this.lastError}; retrying in 30s`);
        await this.sleep(30_000);
      }
    }
  }

  stop(): void {
    this.running = false;
  }
}
