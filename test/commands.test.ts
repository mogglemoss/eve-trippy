/**
 * Drives every command, then every control on every reply, through the fake
 * Discord against the fixture map. Nothing may throw and every payload must
 * fit Discord's limits.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  handleAlertsComponent, handleAutocomplete, handleAvoidComponent, handleAvoidModal, handleCommand, handleNotesComponent, handleNotesModal,
  handleRouteComponent, handleRouteModal, handleSigsComponent, handleWatchComponent, handleWatchModal, type BotContext,
} from '../src/bot/commands.js';
import { handlePanelComponent } from '../src/bot/panel.js';
import { snapshot, universe } from './fixtures.js';
import { asAutocomplete, asButton, asCommand, asModal, asSelect, checkMessage, controls, fakeContext, fakeInteraction, lastSent, type Fake } from './harness.js';

let ctx: BotContext;
const comments = [
  { id: 1, systemId: 31000001, text: 'home sweet home, Trippy says hi', createdAt: new Date(), createdBy: 'Scanner One', modifiedAt: new Date(), modifiedBy: 'Scanner One' },
  { id: 2, systemId: 30000142, text: 'Jita is loud', createdAt: new Date(), createdBy: 'Someone', modifiedAt: new Date(), modifiedBy: 'Someone' },
];

beforeAll(async () => {
  ctx = await fakeContext(snapshot(), comments, {}, universe);
});

async function run(f: Fake) {
  const i = fakeInteraction({ kind: 'command', ...f });
  await handleCommand(asCommand(i), ctx);
  const payload = lastSent(i);
  expect(payload, `${f.command} sent nothing`).toBeTruthy();
  expect(String(payload.content ?? '')).not.toMatch(/Trippy regrets/);
  checkMessage(payload, `/${f.command}`);
  return { i, payload };
}

/** Click a control and check what comes back. */
async function click(c: ReturnType<typeof controls>[number], where: string) {
  const i = fakeInteraction({ kind: c.kind, customId: c.customId, values: c.values });
  const id = c.customId;
  if (id.startsWith('cp|')) await handlePanelComponent(c.kind === 'select' ? asSelect(i) : asButton(i), ctx);
  else if (id.startsWith('rt|')) await handleRouteComponent(c.kind === 'select' ? asSelect(i) : asButton(i), ctx);
  else if (id.startsWith('sg|')) await handleSigsComponent(c.kind === 'select' ? asSelect(i) : asButton(i), ctx);
  else if (id.startsWith('av|')) await handleAvoidComponent(c.kind === 'select' ? asSelect(i) : asButton(i), ctx);
  else if (id.startsWith('wt|')) await handleWatchComponent(c.kind === 'select' ? asSelect(i) : asButton(i), ctx);
  else if (id.startsWith('nt|')) await handleNotesComponent(asButton(i), ctx);
  else if (id.startsWith('al|')) await handleAlertsComponent(asButton(i), ctx);
  else throw new Error(`${where}: unrouted control ${id}`);
  const modal = i.sent.find((s) => s.kind === 'modal');
  const payload = lastSent(i);
  expect(modal || payload, `${where} → ${c.label} (${id}) produced nothing`).toBeTruthy();
  if (payload) checkMessage(payload, `${where} → ${c.label}`);
  return { i, payload, modal };
}

describe('every command answers within Discord limits', () => {
  const cases: Fake[] = [
    { command: 'chain' },
    { command: 'chain', strings: { from: 'J100003' } },
    { command: 'exits' },
    { command: 'eol' },
    { command: 'unknown' },
    { command: 'activity' },
    { command: 'route', strings: { from: 'home', to: 'Jita' } },
    { command: 'route', strings: { from: 'Jita', to: 'Maurasi' } },
    { command: 'route', strings: { from: 'J100001', to: 'Amarr' } },
    { command: 'near', strings: { system: 'Maurasi' } },
    { command: 'sigs', strings: { system: 'J100001' } },
    { command: 'notes', strings: { system: 'J100001' } },
    { command: 'notes', strings: { find: 'loud' } },
    { command: 'notes', strings: { system: 'find: trippy' } },
    { command: 'status' },
    { command: 'avoid', sub: 'list' },
    { command: 'avoid', sub: 'add', strings: { system: 'Niyabainen' } },
    { command: 'watch', sub: 'list' },
    { command: 'watch', sub: 'add', strings: { place: 'Jita' }, ints: { gates: 3 } },
    { command: 'watch', sub: 'add', strings: { place: 'region:The Forge' } },
    { command: 'alerts' },
    { command: 'alerts', strings: { kind: 'connection', state: 'on' } },
  ];
  for (const f of cases) {
    it(`/${f.command}${f.sub ? ' ' + f.sub : ''} ${JSON.stringify(f.strings ?? {})}`, async () => {
      await run(f);
    });
  }

  it('/route reads "A to B" typed into the destination box', async () => {
    const i = fakeInteraction({ kind: 'command', command: 'route', strings: { from: 'home', to: 'J100001 to Jita' } });
    await handleCommand(asCommand(i), ctx);
    const sent = lastSent(i);
    if (!sent.embeds?.length) throw new Error(`no embed; content was: ${sent.content}`);
    const embed = sent.embeds[0].toJSON?.() ?? sent.embeds[0].data ?? sent.embeds[0];
    expect(embed.title).toBe('J100001 → Jita');
    expect(embed.description).toContain('J100001 [SIG-001] ~~> J100002 [SIG-003] ~~> Jita');
  });

  it('reports a missing system politely', async () => {
    const i = fakeInteraction({ kind: 'command', command: 'sigs', strings: { system: 'Nowhere' } });
    await handleCommand(asCommand(i), ctx);
    expect(lastSent(i).content).toMatch(/Trippy regrets: no system matches/);
  });

  it('autocomplete lists chain systems first', async () => {
    const i = fakeInteraction({ kind: 'autocomplete', command: 'sigs', focused: { name: 'system', value: 'j1' } });
    await handleAutocomplete(asAutocomplete(i), ctx);
    const choices = i.sent[0]!.payload as { name: string; value: string }[];
    expect(choices.length).toBeGreaterThan(0);
    expect(choices.length).toBeLessThanOrEqual(25);
    expect(choices[0]!.name).toMatch(/in chain/);
  });
});

describe('every control on every reply works', () => {
  it('walks the panel tabs, root select, refresh and plan', async () => {
    const { payload } = await run({ command: 'chain' });
    const seen = new Set<string>();
    const queue = controls(payload);
    let steps = 0;
    while (queue.length && steps < 60) {
      const c = queue.shift()!;
      if (seen.has(c.customId)) continue;
      seen.add(c.customId);
      steps += 1;
      const out = await click(c, 'panel');
      if (out.payload) for (const n of controls(out.payload)) if (!seen.has(n.customId) && n.customId.startsWith('cp|')) queue.push(n);
    }
    expect(steps).toBeGreaterThan(8);
  });

  it('route buttons: modes, toggles, ship select, swap, edit, details, and "route here"', async () => {
    const { payload } = await run({ command: 'route', strings: { from: 'home', to: 'Maurasi' } });
    const cs = controls(payload);
    // Icon-only controls: identify them by what their customId encodes.
    const ids = cs.map((c) => c.customId);
    expect(ids.some((id) => id.endsWith('|swap'))).toBe(true);
    expect(ids.some((id) => id.endsWith('|edit'))).toBe(true);
    expect(ids.some((id) => /\|f\|/.test(id))).toBe(true); // safer
    expect(ids.some((id) => /\|u\|/.test(id))).toBe(true); // less secure
    expect(ids.some((id) => /\|[a-z-]*d[a-z-]*\|/.test(id.replace(/\|(=|x|ship|swap|edit)$/, '')))).toBe(true); // details toggle
    expect(ids.length).toBeGreaterThanOrEqual(9); // 5 + 5 buttons + ship select, minus the disabled active mode and, with an empty list, the avoid toggle
    for (const c of cs) {
      const out = await click(c, 'route');
      if (c.customId.endsWith('|edit')) expect(out.modal).toBeTruthy();
    }
    const exits = await run({ command: 'exits' });
    const go = controls(exits.payload).filter((c) => c.customId.endsWith('|go'));
    expect(go.length).toBeGreaterThan(0);
    const out = await click(go[0]!, 'exits');
    expect(out.i.sent[0]?.kind).toBe('defer'); // a new message, not an edit of the exits panel
    expect(out.payload.embeds[0].title ?? out.payload.embeds[0].data?.title).toMatch(/→/);
  });

  it('route form submit plans a route; a bad name gets suggestions', async () => {
    const ok = fakeInteraction({ kind: 'modal', customId: 'rtm', fields: { from: '', to: 'Jita' } });
    await handleRouteModal(asModal(ok), ctx);
    checkMessage(lastSent(ok), 'route form');
    const bad = fakeInteraction({ kind: 'modal', customId: 'rtm', fields: { from: '', to: 'J1' } });
    await handleRouteModal(asModal(bad), ctx);
    expect(lastSent(bad).content).toMatch(/Did you mean: J100001/);
  });

  it('sigs: switch system, refresh, notes, route', async () => {
    const { payload } = await run({ command: 'sigs', strings: { system: 'J100001' } });
    for (const c of controls(payload)) await click(c, 'sigs');
  });

  it('notes: search form round-trip', async () => {
    const { payload } = await run({ command: 'notes', strings: { system: 'J100001' } });
    const search = controls(payload).find((c) => c.label === 'Search')!;
    const out = await click(search, 'notes');
    expect(out.modal).toBeTruthy();
    const m = fakeInteraction({ kind: 'modal', customId: 'ntm', fields: { find: 'loud', system: '' } });
    await handleNotesModal(asModal(m), ctx);
    expect(JSON.stringify(lastSent(m))).toMatch(/Jita/);
  });

  it('avoid and watch panels: add via form, remove via select, clear', async () => {
    const { payload } = await run({ command: 'avoid', sub: 'list' });
    const add = controls(payload).find((c) => c.label === 'Add a system')!;
    expect((await click(add, 'avoid')).modal).toBeTruthy();
    const m = fakeInteraction({ kind: 'modal', customId: 'avm', fields: { system: 'Perimeter' } });
    await handleAvoidModal(asModal(m), ctx);
    expect(ctx.prefs.get('guild-1').avoid).toContain(30000144);
    const after = lastSent(m);
    checkMessage(after, 'avoid after add');
    const remove = controls(after).find((c) => c.kind === 'select')!;
    await click(remove, 'avoid');
    const clear = controls(after).find((c) => c.label === 'Clear all')!;
    await click(clear, 'avoid');
    expect(ctx.prefs.get('guild-1').avoid).toEqual([]);

    const w = await run({ command: 'watch', sub: 'list' });
    const wadd = controls(w.payload).find((c) => c.label === 'Add a place')!;
    expect((await click(wadd, 'watch')).modal).toBeTruthy();
    const wm = fakeInteraction({ kind: 'modal', customId: 'wtm', fields: { place: 'Domain', gates: '' } });
    await handleWatchModal(asModal(wm), ctx);
    expect(ctx.prefs.get('guild-1').watches.some((x) => x.region === 'Domain')).toBe(true);
    const wafter = lastSent(wm);
    const wremove = controls(wafter).find((c) => c.kind === 'select')!;
    await click(wremove, 'watch');
  });
});

describe('alert switches', () => {
  it('/alerts shows every kind, a choice flips it, and the buttons toggle in place', async () => {
    const { payload } = await run({ command: 'alerts' });
    const desc = payload.embeds[0].toJSON().description as string;
    expect(desc).toContain('New connection');
    expect(desc).toContain('Kills');
    expect(controls(payload).filter((c) => c.kind === 'button')).toHaveLength(8);

    await run({ command: 'alerts', strings: { kind: 'spent', state: 'on' } });
    expect(ctx.prefs.alertOn('spent')).toBe(true);
    await run({ command: 'alerts', strings: { kind: 'spent' } }); // no state: flip
    expect(ctx.prefs.alertOn('spent')).toBe(false);

    const kills = controls(payload).find((c) => c.customId === 'al|kills')!;
    const after = await click(kills, 'alerts');
    expect(ctx.prefs.alertOn('kills')).toBe(false);
    expect(after.payload.embeds[0].toJSON().description).toContain('Kills** alerts are now **off**');
    await click(kills, 'alerts');
    expect(ctx.prefs.alertOn('kills')).toBe(true);
  });
});

describe('opsec gate', () => {
  it('refuses commands outside allowed channels and without the role, privately', async () => {
    const gated = await fakeContext(snapshot(), [], { ALLOWED_ROLE_IDS: '999', ALLOWED_CHANNEL_IDS: '111' }, universe);
    const wrongChannel = fakeInteraction({ kind: 'command', command: 'chain', channelId: '222', roles: ['999'] });
    await handleCommand(asCommand(wrongChannel), gated);
    expect(wrongChannel.sent[0]).toMatchObject({ kind: 'reply' });
    expect(wrongChannel.sent[0]!.payload.content).toMatch(/only answers in/);
    const noRole = fakeInteraction({ kind: 'command', command: 'chain', channelId: '111', roles: [] });
    await handleCommand(asCommand(noRole), gated);
    expect(noRole.sent[0]!.payload.content).toMatch(/right badge/);
    const ok = fakeInteraction({ kind: 'command', command: 'chain', channelId: '111', roles: ['999'] });
    await handleCommand(asCommand(ok), gated);
    expect(ok.sent[0]!.kind).toBe('defer');
  });
});
