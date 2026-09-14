/** Discord rejects malformed command definitions at registration; catch that here. */
import { describe, expect, it } from 'vitest';
import { commandData } from '../src/bot/commands.js';

describe('slash command definitions', () => {
  it('obey Discord rules', () => {
    expect(commandData.length).toBeLessThanOrEqual(100);
    const names = new Set<string>();
    for (const c of commandData) {
      expect(c.name, 'name').toMatch(/^[a-z0-9_-]{1,32}$/);
      expect(names.has(c.name), `duplicate ${c.name}`).toBe(false);
      names.add(c.name);
      expect(c.description.length, `${c.name} description`).toBeLessThanOrEqual(100);
      const opts = (c.options ?? []) as { name: string; description: string; required?: boolean; type: number; options?: unknown[]; choices?: unknown[] }[];
      expect(opts.length).toBeLessThanOrEqual(25);
      let seenOptional = false;
      for (const o of opts) {
        expect(o.name).toMatch(/^[a-z0-9_-]{1,32}$/);
        expect(o.description.length, `${c.name}.${o.name} description`).toBeLessThanOrEqual(100);
        if (o.type === 1) { // subcommand
          for (const so of (o.options ?? []) as typeof opts) expect(so.description.length).toBeLessThanOrEqual(100);
          continue;
        }
        if (o.required) expect(seenOptional, `${c.name}: required option "${o.name}" after an optional one`).toBe(false);
        else seenOptional = true;
      }
    }
  });
});
