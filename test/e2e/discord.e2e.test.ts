/**
 * Live: the Discord side — token, guild, channels, command registration —
 * without starting the gateway. Opt in with TRIPPY_E2E_DISCORD=1; needs .env.
 * Registration is idempotent, so running this re-registers the real commands.
 */
import { REST, Routes } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { commandData } from '../../src/bot/commands.js';
import { loadConfig, loadDotEnv } from '../../src/config.js';

const live = process.env.TRIPPY_E2E_DISCORD === '1';

describe.skipIf(!live)('live Discord', () => {
  loadDotEnv();
  const config = loadConfig();
  const rest = new REST().setToken(config.discord.token);

  it('token belongs to the configured application', async () => {
    const me = (await rest.get(Routes.user())) as { id: string; username: string; bot: boolean };
    expect(me.bot).toBe(true);
    const app = (await rest.get(Routes.currentApplication())) as { id: string };
    expect(app.id).toBe(config.discord.clientId);
  });

  it('is in the guild and can see the alert (and kill) channel', async () => {
    const guildId = config.discord.guildId!;
    const member = (await rest.get(Routes.guildMember(guildId, config.discord.clientId))) as { roles: string[] };
    expect(Array.isArray(member.roles)).toBe(true);
    for (const id of [config.discord.alertChannelId, config.discord.killChannelId].filter((x): x is string => !!x)) {
      const ch = (await rest.get(Routes.channel(id))) as { type: number; name: string };
      expect([0, 5, 11, 12].includes(ch.type), `${ch.name} is a text channel`).toBe(true);
    }
  });

  it('accepts the command definitions', async () => {
    const guildId = config.discord.guildId;
    const route = guildId ? Routes.applicationGuildCommands(config.discord.clientId, guildId) : Routes.applicationCommands(config.discord.clientId);
    const result = (await rest.put(route, { body: commandData })) as { name: string }[];
    expect(result.map((c) => c.name).sort()).toEqual(commandData.map((c) => c.name).sort());
  });
});
