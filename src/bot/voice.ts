/**
 * Trippy's voice: a courteous clerical robot from the Department of Spatial
 * Relations. It observes, files, and occasionally remarks. It never judges.
 */

const FOOTERS = [
  'The Ministry is merely noting.',
  'Observed, not judged.',
  'Filed without further comment.',
  'A scan is a promise. A map is a rumour.',
  'Everything above observes; nothing above judges.',
  'Recorded at the moment the record holds it, and not one second sooner.',
  'Trippy has seen worse. Trippy has also seen better.',
  'Undock responsibly.',
  'This message will not self-destruct. It will merely expire.',
  'Wormholes close. Paperwork is forever.',
];

let cursor = Math.floor(Math.random() * FOOTERS.length);

/** Rotates through the sign-offs so two consecutive replies never share one. */
export function signOff(): string {
  cursor = (cursor + 1) % FOOTERS.length;
  return FOOTERS[cursor]!;
}

export const AUTHOR = 'TRIPPY · Dept. of Spatial Relations';

export const empty = {
  map: 'The map is empty. Somebody go and scan something.',
  chain: (home: string) => `${home} has no known holes. Either it is very quiet or nobody has looked.`,
  exits: 'No k-space or Thera exits on the map. Trippy suggests not panicking, in writing.',
  eol: 'Nothing is dying and nothing is heavy. Trippy finds this suspicious and has said so.',
  sigs: (name: string) => `Nothing scanned in ${name}. The record is blank and, presumably, so is the sky.`,
  notes: (name: string) => `No notes on ${name}. Nobody has had opinions about it yet.`,
  route: (name: string) => `You are already in ${name}. Trippy admires the efficiency.`,
};

export const regrets = (message: string) => `⚠️ Trippy regrets: ${message}`;

/** Brand palette, from the mascot. */
export const COLOUR = {
  orange: 0xe8782a,
  amber: 0xffc25a,
  mustard: 0xd9a441,
  teal: 0x1f5b66,
  red: 0xd4432f,
  green: 0x4caf50,
  grey: 0x607d8b,
  purple: 0x9c27b0,
  blue: 0x2196f3,
} as const;
