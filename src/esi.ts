/**
 * The little of ESI Trippy needs: resolving IDs to names (ships, pilots,
 * corps, alliances) and the hourly per-system kill and jump counts.
 * Everything is cached; ESI is polite about that and so are we.
 */
const ESI = 'https://esi.evetech.net/latest';
import { USER_AGENT as UA } from './ua.js';

export interface NamedEntity {
  id: number;
  name: string;
  category: string;
}

export interface SystemActivity {
  shipKills: number;
  podKills: number;
  npcKills: number;
  jumps: number;
}

export interface CorpInfo { id: number; name: string; ticker: string; allianceId: number | null }
export interface AllianceInfo { id: number; name: string; ticker: string }

export class Esi {
  private names = new Map<number, NamedEntity>();
  private corps = new Map<number, CorpInfo | null>();
  private alliances = new Map<number, AllianceInfo | null>();
  private activity: { at: number; expires: number; bySystem: Map<number, SystemActivity> } | null = null;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /** Resolve up to 1000 IDs per call; unknown IDs (e.g. deleted characters) are simply absent. */
  async resolveNames(ids: Iterable<number>): Promise<Map<number, NamedEntity>> {
    const wanted = [...new Set(ids)].filter((id) => Number.isFinite(id) && id > 0 && !this.names.has(id));
    for (let i = 0; i < wanted.length; i += 1000) {
      const batch = wanted.slice(i, i + 1000);
      try {
        const res = await this.fetchImpl(`${ESI}/universe/names/?datasource=tranquility`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Accept: 'application/json' },
          body: JSON.stringify(batch),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) continue;
        for (const e of (await res.json()) as NamedEntity[]) this.names.set(e.id, e);
      } catch {
        // leave them unresolved; the caller falls back to the id
      }
    }
    const out = new Map<number, NamedEntity>();
    for (const id of new Set(ids)) {
      const e = this.names.get(id);
      if (e) out.set(id, e);
    }
    return out;
  }

  async corp(id: number): Promise<CorpInfo | null> {
    if (this.corps.has(id)) return this.corps.get(id)!;
    let info: CorpInfo | null = null;
    try {
      const res = await this.fetchImpl(`${ESI}/corporations/${id}/?datasource=tranquility`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const j = (await res.json()) as { name: string; ticker: string; alliance_id?: number };
        info = { id, name: j.name, ticker: j.ticker, allianceId: j.alliance_id ?? null };
      }
    } catch { /* unresolved */ }
    this.corps.set(id, info);
    return info;
  }

  async alliance(id: number): Promise<AllianceInfo | null> {
    if (this.alliances.has(id)) return this.alliances.get(id)!;
    let info: AllianceInfo | null = null;
    try {
      const res = await this.fetchImpl(`${ESI}/alliances/${id}/?datasource=tranquility`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const j = (await res.json()) as { name: string; ticker: string };
        info = { id, name: j.name, ticker: j.ticker };
      }
    } catch { /* unresolved */ }
    this.alliances.set(id, info);
    return info;
  }

  name(id: number | null | undefined, fallback = 'unknown'): string {
    if (!id) return fallback;
    return this.names.get(id)?.name ?? fallback;
  }

  /** Last hour's kills and jumps for every system, refreshed when ESI's cache expires. */
  async systemActivity(): Promise<Map<number, SystemActivity>> {
    const now = Date.now();
    if (this.activity && now < this.activity.expires) return this.activity.bySystem;
    const bySystem = new Map<number, SystemActivity>();
    const get = async (path: string): Promise<{ rows: unknown[]; expires: number }> => {
      const res = await this.fetchImpl(`${ESI}${path}?datasource=tranquility`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`ESI ${path} answered ${res.status}`);
      const exp = Date.parse(res.headers.get('expires') ?? '') || now + 600_000;
      return { rows: (await res.json()) as unknown[], expires: exp };
    };
    const [kills, jumps] = await Promise.all([get('/universe/system_kills/'), get('/universe/system_jumps/')]);
    const entry = (id: number) => {
      let a = bySystem.get(id);
      if (!a) bySystem.set(id, (a = { shipKills: 0, podKills: 0, npcKills: 0, jumps: 0 }));
      return a;
    };
    for (const r of kills.rows as { system_id: number; ship_kills: number; pod_kills: number; npc_kills: number }[]) {
      const a = entry(r.system_id);
      a.shipKills = r.ship_kills;
      a.podKills = r.pod_kills;
      a.npcKills = r.npc_kills;
    }
    for (const r of jumps.rows as { system_id: number; ship_jumps: number }[]) entry(r.system_id).jumps = r.ship_jumps;
    this.activity = { at: now, expires: Math.min(kills.expires, jumps.expires), bySystem };
    return bySystem;
  }
}
