/**
 * Renderings for Discord and for the terminal. Every function returns lines.
 *
 * In markdown mode (opts.md) system names link to Tripwire, classes become
 * code pills with a colour dot, and trees indent with ideographic spaces so
 * they survive Discord's proportional font. In plain mode the same lines come
 * out as bare text for the probe CLI and tests.
 */
import type { Signature } from '../tripwire/types.js';
import {
  classLabel, describeHole, genericLabel, isRealSystemId, secDisplay, systemBadge, type ClassKey, type SystemInfo, type Universe,
} from '../universe/index.js';
import { farSide, holeLabel, nearSig, farSig, type Chain, type Connection, type TreeNode } from './graph.js';

export interface RenderOpts {
  universe: Universe;
  now: Date;
  home?: Set<number>;
  /** Base URL of the Tripwire instance; enables ?system= links in markdown mode. */
  tripwireUrl?: string;
  /** Discord markdown (links, bold, pills). Off for the terminal. */
  md?: boolean;
}

/** Wide space that Discord preserves, used for tree indentation. */
export const INDENT = '　';

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

export function fmtSig(sigId: string | null): string {
  if (!sigId) return '???';
  return sigId.length === 6 ? `${sigId.slice(0, 3)}-${sigId.slice(3)}` : sigId;
}

export function timeLeft(expiresAt: Date | null, now: Date): string {
  if (!expiresAt) return '—';
  const ms = expiresAt.getTime() - now.getTime();
  if (ms <= 0) return 'past due';
  const mins = Math.floor(ms / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function ago(at: Date, now: Date): string {
  const mins = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function connectionFlags(c: Connection, md = false): string[] {
  const flags: string[] = [];
  if (c.life === 'critical') flags.push(md ? '⏳ EOL' : 'EOL');
  if (c.mass === 'critical') flags.push(md ? '🔴 crit mass' : 'MASS CRIT');
  else if (c.mass === 'destab') flags.push(md ? '🟠 destab' : 'destab');
  return flags;
}

/**
 * A glyph per class. Known space follows the client's route bar: solid
 * squares coloured by security, a triangle for Triglavian-held Pochven.
 * Wormhole space is circles, so the two kinds of space read apart.
 */
export function classDot(cls: ClassKey): string {
  switch (cls) {
    case 'hs': return '🟩';
    case 'ls': return '🟧';
    case 'ns': return '🟥';
    case 'pochven': return '🔺';
    case 'c1': case 'c2': case 'c3': return '🔵';
    case 'c4': case 'c5': case 'c6': return '🟣';
    case 'c13': return '🔹';
    case 'thera': return '🟡';
    case 'sentinel': case 'barbican': case 'vidette': case 'conflux': case 'redoubt': return '⚫';
    default: return '⚪';
  }
}

export function systemUrl(opts: RenderOpts, name: string): string | null {
  if (!opts.tripwireUrl) return null;
  return `${opts.tripwireUrl}/?system=${encodeURIComponent(name)}`;
}

export function systemName(u: Universe, id: number | null): string {
  if (!isRealSystemId(id)) return genericLabel(id);
  return u.systems.get(id)?.name ?? `#${id}`;
}

function md(opts: RenderOpts): boolean {
  return opts.md === true;
}

/** The name, linked and bold in markdown mode. */
export function nameLink(opts: RenderOpts, s: SystemInfo): string {
  if (!md(opts)) return s.name;
  const url = systemUrl(opts, s.name);
  return url ? `**[${s.name}](${url})**` : `**${s.name}**`;
}

/**
 * "J121116 C4" / "Jita HS 0.9" / "High-Sec" (generic) / "Unknown".
 * Markdown: "🟣 **[J121116](url)** `C4` 🏠".
 */
export function systemLabel(opts: RenderOpts, id: number | null): string {
  const u = opts.universe;
  if (!isRealSystemId(id)) return md(opts) ? `⚪ *${genericLabel(id)}*` : genericLabel(id);
  const s = u.systems.get(id);
  if (!s) return `#${id}`;
  const isHome = opts.home?.has(id) ?? false;
  if (!md(opts)) return `${s.name} ${systemBadge(s)}${isHome ? ' ⌂' : ''}`;
  return `${classDot(s.cls)} ${nameLink(opts, s)} \`${systemBadge(s)}\`${isHome ? ' 🏠' : ''}`;
}

export function systemHeadline(opts: RenderOpts, s: SystemInfo): string {
  const bits = [md(opts) ? `${classDot(s.cls)} ${nameLink(opts, s)} \`${systemBadge(s)}\`` : `${s.name} ${systemBadge(s)}`];
  if (s.effect) bits.push(s.effect);
  if (s.statics.length) bits.push(`statics ${s.statics.join('/')}`);
  bits.push(md(opts) ? `*${s.region}*` : s.region);
  return bits.join(' · ');
}

const sig = (opts: RenderOpts, s: Signature) => (md(opts) ? `**${fmtSig(s.sigId)}**` : fmtSig(s.sigId));

/** One hop as seen from `from`: "ABC-123 C247 → J121116 C4 · 15h 40m · EOL". */
export function connectionLine(c: Connection, from: number, opts: RenderOpts): string {
  const to = farSide(c, from);
  const bits = [`${sig(opts, nearSig(c, from))} ${holeLabel(c, from)} → ${systemLabel(opts, to)}`];
  bits.push(timeLeft(c.expiresAt, opts.now));
  bits.push(...connectionFlags(c, md(opts)));
  return bits.join(' · ');
}

// ---------------------------------------------------------------------------
// Compositions
// ---------------------------------------------------------------------------

export function renderTree(node: TreeNode, opts: RenderOpts): string[] {
  const u = opts.universe;
  const root = isRealSystemId(node.system) ? u.systems.get(node.system) : undefined;
  const isHome = !!root && (opts.home?.has(root.id) ?? false);
  const head = root ? systemHeadline(opts, root) : systemLabel(opts, node.system);
  const lines = [isHome ? (md(opts) ? `🏠 ${head}` : `⌂ ${head}`) : head];
  walk(node, '', lines, opts);
  return lines;
}

function walk(node: TreeNode, prefix: string, lines: string[], opts: RenderOpts): void {
  if (!isRealSystemId(node.system)) return;
  const sys = node.system;
  const useMd = md(opts);
  type Item = { kind: 'child'; node: TreeNode } | { kind: 'loop'; c: Connection };
  const items: Item[] = [
    ...node.children.map((n): Item => ({ kind: 'child', node: n })),
    ...node.loops.map((c): Item => ({ kind: 'loop', c })),
  ];
  items.forEach((item, i) => {
    const last = i === items.length - 1;
    const branch = useMd ? '└ ' : last ? '└─ ' : '├─ ';
    const nextPrefix = useMd ? prefix + INDENT : prefix + (last ? '   ' : '│  ');
    if (item.kind === 'child' && item.node.via) {
      lines.push(prefix + branch + connectionLine(item.node.via, sys, opts));
      walk(item.node, nextPrefix, lines, opts);
    } else if (item.kind === 'loop') {
      lines.push(`${prefix}${branch}↻ ${connectionLine(item.c, sys, opts)} (shown above)`);
    }
  });
}

export function renderRoute(path: Connection[], from: number, opts: RenderOpts): string[] {
  const lines = [systemLabel(opts, from)];
  let here = from;
  path.forEach((c, i) => {
    const to = farSide(c, here);
    const tail = [timeLeft(c.expiresAt, opts.now), ...connectionFlags(c, md(opts))].join(' · ');
    const n = md(opts) ? `**${i + 1}.**` : `${String(i + 1).padStart(2)}.`;
    lines.push(`${n} warp ${sig(opts, nearSig(c, here))} ${holeLabel(c, here)} → ${systemLabel(opts, to)} · land on ${fmtSig(farSig(c, here).sigId)} · ${tail}`);
    if (isRealSystemId(to)) here = to;
  });
  return lines;
}

export function renderSigs(sigs: Signature[], sys: number, chain: Chain, opts: RenderOpts): string[] {
  const bySig = new Map<number, Connection>();
  for (const c of chain.adj.get(sys) ?? []) bySig.set(nearSig(c, sys).id, c);
  const ordered = [...sigs].sort((x, y) => {
    const t = (x.type === 'wormhole' ? 0 : 1) - (y.type === 'wormhole' ? 0 : 1);
    return t || (x.sigId ?? '~').localeCompare(y.sigId ?? '~');
  });
  return ordered.map((s) => {
    const c = bySig.get(s.id);
    const life = timeLeft(s.lifeLengthSec > 0 ? s.expiresAt : null, opts.now);
    let detail: string;
    if (c) {
      detail = [`${holeLabel(c, sys)} → ${systemLabel(opts, farSide(c, sys))}`, timeLeft(c.expiresAt, opts.now), ...connectionFlags(c, md(opts))].join(' · ');
    } else {
      detail = [s.name ?? (s.type === 'wormhole' ? 'unlinked wormhole' : null), life].filter(Boolean).join(' · ');
    }
    const type = md(opts) ? (s.type === 'wormhole' ? '🌀 `wormhole`' : `\`${s.type}\``) : s.type.padEnd(8);
    return `${sig(opts, s)} ${type} ${detail}`;
  });
}

export interface Exit {
  system: SystemInfo;
  path: Connection[];
}

export function renderExits(exits: Exit[], from: number, opts: RenderOpts): string[] {
  return exits.map((e) => {
    const first = e.path[0];
    const via = first ? `via ${fmtSig(nearSig(first, from).sigId)}` : 'you are here';
    const flags = e.path.flatMap((c) => connectionFlags(c, md(opts)));
    const worst = flags.find((f) => f.includes('crit')) ?? flags.find((f) => f.includes('EOL'));
    const bits = [systemLabel(opts, e.system.id), `${e.path.length} jump${e.path.length === 1 ? '' : 's'}`, via, md(opts) ? `*${e.system.region}*` : e.system.region];
    if (e.path.length) bits.push(timeLeft(minExpiry(e.path), opts.now));
    if (worst) bits.push(`${worst} on route`);
    return bits.join(' · ');
  });
}

export function minExpiry(path: Connection[]): Date | null {
  const times = path.map((c) => c.expiresAt?.getTime()).filter((t): t is number => typeof t === 'number');
  return times.length ? new Date(Math.min(...times)) : null;
}

/** Both ends and the flags: "J121116 C4 ABC-123 ⇄ DEF-456 Jita HS 0.9 [D845] · EOL · 2h 10m". */
export function connectionSummary(c: Connection, opts: RenderOpts): string {
  const left = `${systemLabel(opts, c.a)} ${fmtSig(c.sigA.sigId)}`;
  const right = `${fmtSig(c.sigB.sigId)} ${systemLabel(opts, c.b)}`;
  const type = c.type ? (md(opts) ? ` \`${c.type}\`` : ` [${c.type}]`) : '';
  return [`${left} ⇄ ${right}${type}`, ...connectionFlags(c, md(opts)), timeLeft(c.expiresAt, opts.now)].join(' · ');
}

export function holeInfo(u: Universe, c: Connection): string | null {
  return c.type ? describeHole(u, c.type) : null;
}

/** Wrap lines into ```-fenced chunks that fit Discord's 2000-character limit. */
export function codeBlocks(lines: string[], limit = 1900): string[] {
  return chunkLines(lines, limit).map((chunk) => '```\n' + chunk.join('\n') + '\n```');
}

/** Split lines into groups whose joined length stays under `limit`. */
export function chunkLines(lines: string[], limit: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    const cost = line.length + 1;
    if (size + cost > limit && current.length) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += cost;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

// ---------------------------------------------------------------------------
// Mixed routes (wormholes + stargates)
// ---------------------------------------------------------------------------

import type { Route, Step } from './route.js';
import { holeLabel as _holeLabel, nearSig as _nearSig, farSig as _farSig } from './graph.js';

/**
 * One line per wormhole hop; consecutive gate jumps are folded into a single
 * line naming every system passed, with the lowest security called out.
 */
export function renderSteps(route: Route, opts: RenderOpts): string[] {
  const u = opts.universe;
  const useMd = md(opts);
  const lines = [systemLabel(opts, route.from)];
  let here = route.from;
  let n = 0;
  const num = () => (useMd ? `**${++n}.**` : `${String(++n).padStart(2)}.`);
  let i = 0;
  while (i < route.steps.length) {
    const step = route.steps[i]!;
    if (step.kind === 'scout') {
      const h = step.hole;
      const fromHub = here === h.hubId;
      const sigHere = fromHub ? h.hubSignature : h.outSignature;
      const sigThere = fromHub ? h.outSignature : h.hubSignature;
      const type = fromHub ? (h.type ?? '???') : 'K162';
      const life = h.remainingHours === null ? '' : ` · ~${h.remainingHours}h`;
      const size = h.maxShipSize ? ` · ${h.maxShipSize}` : '';
      const sigTxt = useMd ? `**${sigHere ?? '???'}**` : (sigHere ?? '???');
      lines.push(`${num()} ${useMd ? '🌀 ' : ''}warp ${sigTxt} ${type} → ${systemLabel(opts, step.to)} · land on ${sigThere ?? '???'}${life}${size} · EVE-Scout`);
      here = step.to;
      i += 1;
      continue;
    }
    if (step.kind === 'hole') {
      const c = step.c;
      const tail = [timeLeft(c.expiresAt, opts.now), ...connectionFlags(c, useMd)].join(' · ');
      lines.push(`${num()} ${useMd ? '🌀 ' : ''}warp ${sig(opts, _nearSig(c, here))} ${_holeLabel(c, here)} → ${systemLabel(opts, step.to)} · land on ${fmtSig(_farSig(c, here).sigId)} · ${tail}`);
      here = step.to;
      i += 1;
      continue;
    }
    // Fold the run of gates.
    const run: Step[] = [];
    while (i < route.steps.length && route.steps[i]!.kind === 'gate') run.push(route.steps[i++]!);
    const last = run[run.length - 1]!;
    const names = run.slice(0, -1).map((s) => {
      const sys = u.systems.get(s.to);
      if (!sys) return `#${s.to}`;
      return useMd ? `${nameLink(opts, sys)}` : sys.name;
    });
    const lowest = run
      .map((s) => u.systems.get(s.to))
      .filter((s): s is SystemInfo => !!s && s.sec !== null)
      .sort((a, b) => a.sec! - b.sec!)[0];
    const via = names.length ? ` via ${names.join(' → ')}` : '';
    // Flag a run that dips below highsec; a highsec-only run says nothing.
    const low = lowest && lowest.cls !== 'hs'
      ? ` · ⚠️ ${lowest.cls === 'ls' ? 'lowsec' : lowest.cls === 'ns' ? 'nullsec' : classLabel(lowest.cls)}${lowest.sec !== null ? ` ${secDisplay(lowest.sec)}` : ''} at ${lowest.name}`
      : '';
    lines.push(`${num()} ${useMd ? '🚀 ' : ''}${run.length} gate${run.length === 1 ? '' : 's'}${via} → ${systemLabel(opts, last.to)}${low}`);
    here = last.to;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Copy-and-paste forms of a route for the EVE client
// ---------------------------------------------------------------------------

/** Every system on the route in order, origin first. */
export function routeSystems(route: Route): number[] {
  return [route.from, ...route.steps.map((s) => s.to)];
}

/**
 * Short Circuit's copy format, which the corp already reads:
 * `Jita --> ... --> Kappas [TIN-875] ~~> J120310 [IYJ-120] ~~> ... ~~> Onga --> ... --> Rens`
 * Gate runs collapse to `--> ... -->` (a single gate is just `-->`); each
 * wormhole jump is `~~>` with the signature to warp to in brackets after the
 * system you leave.
 */
export function routeChatLine(route: Route, u: Universe): string {
  const name = (id: number) => u.systems.get(id)?.name ?? String(id);
  let out = name(route.from);
  let here = route.from;
  let i = 0;
  while (i < route.steps.length) {
    const step = route.steps[i]!;
    if (step.kind === 'gate') {
      let n = 0;
      let lastTo = step.to;
      while (i < route.steps.length && route.steps[i]!.kind === 'gate') { lastTo = route.steps[i]!.to; n++; i++; }
      out += n === 1 ? ` --> ${name(lastTo)}` : ` --> ... --> ${name(lastTo)}`;
      here = lastTo;
      continue;
    }
    const sigHere = step.kind === 'hole'
      ? fmtSig(_nearSig(step.c, here).sigId)
      : (step.hole.hubId === here ? step.hole.hubSignature : step.hole.outSignature) ?? '???';
    out += ` [${sigHere}] ~~> ${name(step.to)}`;
    here = step.to;
    i++;
  }
  return out;
}


/**
 * The route as a security strip: one glyph per system coloured by class.
 * Compact: names only at the origin, the destination, and either side of a
 * hole (🌀). Detailed: every system named, and each hole carries the
 * signature to warp to, the time left, and any EOL / mass flag. Security is
 * never spelled out — the square colours say it.
 */
export function routeStrip(route: Route, opts: RenderOpts, detailed = false): string {
  const u = opts.universe;
  const useMd = md(opts);
  // In markdown each square links to its system on Tripwire: the hover shows
  // the target (…?system=Name) and a click opens it on the map.
  const dot = (id: number) => {
    const s = u.systems.get(id);
    const glyph = classDot(s?.cls ?? 'unknown');
    const url = s && useMd ? systemUrl(opts, s.name) : null;
    return url ? `[${glyph}](${url})` : glyph;
  };
  const named = (id: number) => {
    const s = u.systems.get(id);
    const glyph = classDot(s?.cls ?? 'unknown'); // the name carries the link here
    if (!s) return `${glyph}#${id}`;
    return `${glyph}${useMd ? nameLink(opts, s) : s.name}`;
  };
  const hole = (step: Step, here: number): string => {
    if (!detailed) return '🌀';
    if (step.kind === 'hole') {
      const sigTxt = fmtSig(_nearSig(step.c, here).sigId);
      const bits = [sigTxt, timeLeft(step.c.expiresAt, opts.now), ...connectionFlags(step.c, useMd)];
      return `🌀${useMd ? `**${sigTxt}**` : sigTxt}${bits.slice(1).length ? ` ${bits.slice(1).join(' ')}` : ''}`;
    }
    if (step.kind === 'scout') {
      const sigHere = (step.hole.hubId === here ? step.hole.hubSignature : step.hole.outSignature) ?? '???';
      const life = step.hole.remainingHours === null ? '' : ` ~${step.hole.remainingHours}h`;
      return `🌀${useMd ? `**${sigHere}**` : sigHere}${life} EVE-Scout`;
    }
    return '🌀';
  };
  let out = named(route.from);
  let here = route.from;
  let i = 0;
  while (i < route.steps.length) {
    const step = route.steps[i]!;
    if (step.kind === 'gate') {
      const run: number[] = [];
      while (i < route.steps.length && route.steps[i]!.kind === 'gate') run.push(route.steps[i++]!.to);
      const last = run.pop()!;
      if (detailed) out += ` ${[...run, last].map(named).join(' ')}`;
      else out += run.length ? ` ${run.map(dot).join('\u2009')} ${named(last)}` : ` ${named(last)}`;
      here = last;
      continue;
    }
    out += ` ${hole(step, here)} ${named(step.to)}`;
    here = step.to;
    i++;
  }
  return out;
}
