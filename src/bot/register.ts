/** Registers the slash commands. Run once, and again whenever commands change. */
import { REST, Routes } from 'discord.js';
import { loadConfig, loadDotEnv } from '../config.js';
import { commandData } from './commands.js';

loadDotEnv();
const config = loadConfig();
const rest = new REST().setToken(config.discord.token);
const route = config.discord.guildId
  ? Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId)
  : Routes.applicationCommands(config.discord.clientId);
await rest.put(route, { body: commandData });
console.log(`registered ${commandData.length} commands ${config.discord.guildId ? `to guild ${config.discord.guildId}` : 'globally (may take up to an hour to appear)'}: ${commandData.map((c) => '/' + c.name).join(' ')}`);
