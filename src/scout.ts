/**
 * EVE-Scout's public Thera and Turnur connections. Free, unauthenticated,
 * cached five minutes upstream; we cache the same. These are holes the corp
 * did not scan but can still use, so routing treats them as extra edges.
 */
export interface ScoutHole {
  id: string;
  /** Thera or Turnur. */
  hubId: number;
  hubName: string;
  hubSignature: string | null;
  /** The far end in k-space or J-space. */
  outId: number;
  outName: string;
  outSignature: string | null;
  /** Named type as seen from the hub side (K162 when the hole exits outward). */
  type: string | null;
  maxShipSize: string | null;
  remainingHours: number | null;
  expiresAt: Date | null;
  updatedAt: Date | null;
}

interface Raw {
  id: string;
  completed?: boolean;
  wh_exits_outward?: boolean;
  wh_type?: string | null;
  max_ship_size?: string | null;
  remaining_hours?: number | null;
  expires_at?: string | null;
  updated_at?: string | null;
  signature_type?: string;
  out_system_id: number;
  out_system_name: string;
  out_signature?: string | null;
  in_system_id: number;
  in_system_name: string;
  in_signature?: string | null;
}

const URL = 'https://api.eve-scout.com/v2/public/signatures';
import { USER_AGENT as UA } from './ua.js';
const TTL_MS = 5 * 60_000;

export class EveScout {
  private cache: { at: number; holes: ScoutHole[] } | null = null;
  lastError: string | null = null;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async holes(): Promise<ScoutHole[]> {
    if (this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache.holes;
    try {
      const res = await this.fetchImpl(URL, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`EVE-Scout answered ${res.status}`);
      const rows = (await res.json()) as Raw[];
      const holes = rows
        .filter((r) => (r.signature_type ?? 'wormhole') === 'wormhole' && r.out_system_id && r.in_system_id)
        .map((r): ScoutHole => ({
          id: String(r.id),
          hubId: r.out_system_id,
          hubName: r.out_system_name,
          hubSignature: r.out_signature ?? null,
          outId: r.in_system_id,
          outName: r.in_system_name,
          outSignature: r.in_signature ?? null,
          type: r.wh_type ?? null,
          maxShipSize: r.max_ship_size ?? null,
          remainingHours: r.remaining_hours ?? null,
          expiresAt: r.expires_at ? new Date(r.expires_at) : null,
          updatedAt: r.updated_at ? new Date(r.updated_at) : null,
        }));
      this.cache = { at: Date.now(), holes };
      this.lastError = null;
      return holes;
    } catch (e) {
      this.lastError = (e as Error).message;
      return this.cache?.holes ?? [];
    }
  }
}
