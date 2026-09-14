/** A killmail reduced to what Trippy announces. */
export interface Kill {
  id: number;
  hash: string;
  time: Date;
  systemId: number;
  victim: {
    characterId: number | null;
    corporationId: number | null;
    allianceId: number | null;
    shipTypeId: number | null;
  };
  attackers: number;
  finalBlow: {
    characterId: number | null;
    corporationId: number | null;
    allianceId: number | null;
    shipTypeId: number | null;
  } | null;
  /** Corporation and alliance IDs of every attacker, for "friendly" detection. */
  attackerCorps: Set<number>;
  attackerAlliances: Set<number>;
  attackerList: { characterId: number | null; corporationId: number | null; allianceId: number | null; shipTypeId: number | null }[];
  totalValue: number;
  npc: boolean;
  solo: boolean;
  awox: boolean;
  labels: string[];
}
