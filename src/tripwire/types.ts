export type SigType = 'unknown' | 'combat' | 'data' | 'relic' | 'ore' | 'gas' | 'wormhole';
export type Life = 'stable' | 'critical';
export type Mass = 'stable' | 'destab' | 'critical';
export type ParentSide = 'initial' | 'secondary';

/** A row of Tripwire's `signatures` table as the API emits it (PDO: everything is a string). */
export interface RawSignature {
  id: string | number;
  signatureID?: string | null;
  systemID?: string | number | null;
  type: string;
  name?: string | null;
  bookmark?: string | null;
  lifeTime: string;
  lifeLeft: string;
  lifeLength: string | number;
  createdByID?: string | number;
  createdByName?: string | null;
  modifiedByID?: string | number;
  modifiedByName?: string | null;
  modifiedTime: string;
  maskID?: string | number;
}

export interface RawWormhole {
  id: string | number;
  initialID: string | number;
  secondaryID: string | number;
  type?: string | null;
  parent?: string | null;
  life: string;
  mass: string;
  maskID?: string | number;
}

export interface RawComment {
  id: string | number;
  systemID: string | number;
  comment: string;
  created: string;
  createdByID?: string | number;
  createdByName?: string | null;
  modified: string;
  modifiedByID?: string | number;
  modifiedByName?: string | null;
  maskID?: string | number;
}

export interface Signature {
  id: number;
  /** Six-character ID like "ABC123", or null when the scanner did not know it. */
  sigId: string | null;
  /** Real solar system ID, a small Tripwire generic index, or null. */
  systemId: number | null;
  type: SigType;
  name: string | null;
  bookmark: string | null;
  createdAt: Date;
  expiresAt: Date;
  lifeLengthSec: number;
  createdBy: string;
  modifiedBy: string;
  modifiedAt: Date;
}

export interface Wormhole {
  id: number;
  /** signatures.id of each end. */
  initialId: number;
  secondaryId: number;
  /** The named hole code (C247, B274 …) as entered on the parent side; the other side is its K162. */
  type: string | null;
  parent: ParentSide | null;
  life: Life;
  mass: Mass;
}

export interface Comment {
  id: number;
  systemId: number;
  text: string;
  createdAt: Date;
  createdBy: string;
  modifiedAt: Date;
  modifiedBy: string;
}

export interface Snapshot {
  signatures: Signature[];
  wormholes: Wormhole[];
  fetchedAt: Date;
}
