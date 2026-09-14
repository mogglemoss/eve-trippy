import { existsSync } from 'node:fs';

export interface Config {
  discord: {
    token: string;
    clientId: string;
    guildId: string | null;
    alertChannelId: string | null;
    /** Kill alerts go here; falls back to the alert channel. */
    killChannelId: string | null;
  };
  /** Corp and alliance IDs that count as "us" in kill alerts. */
  friendlyIds: number[];
  /** Opsec: when non-empty, only members with one of these roles may use commands. */
  allowedRoleIds: string[];
  /** Opsec: when non-empty, commands work only in these channels. */
  allowedChannelIds: string[];
  /** Replies visible only to the caller by default. */
  ephemeral: boolean;
  /** Which mapped systems get kill alerts. */
  killAlerts: 'jspace' | 'all' | 'off';
  tripwire: {
    url: string;
    username: string;
    password: string;
    maskId: string;
    /** What replies call this Tripwire ("Tripwire", "Tripwire dev"). Never the URL. */
    label: string;
  };
  /** Home system names as configured; resolved to IDs at start. */
  homeSystems: string[];
  pollSeconds: number;
  stateFile: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Reads .env (or ENV_FILE) into process.env when present. Node's own loader — no dotenv. */
export function loadDotEnv(path = process.env.ENV_FILE?.trim() || '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env, opts: { requireDiscord?: boolean } = {}): Config {
  const requireDiscord = opts.requireDiscord ?? true;
  const missing: string[] = [];
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) missing.push(name);
    return v ?? '';
  };
  const optional = (name: string): string | null => env[name]?.trim() || null;

  const tripwire = {
    url: need('TRIPWIRE_URL').replace(/\/+$/, ''),
    username: need('TRIPWIRE_USERNAME'),
    password: need('TRIPWIRE_PASSWORD'),
    maskId: need('TRIPWIRE_MASK_ID'),
    label: env.TRIPWIRE_LABEL?.trim() || 'Tripwire',
  };
  const discord = {
    token: requireDiscord ? need('DISCORD_TOKEN') : env.DISCORD_TOKEN?.trim() ?? '',
    clientId: requireDiscord ? need('DISCORD_CLIENT_ID') : env.DISCORD_CLIENT_ID?.trim() ?? '',
    guildId: optional('DISCORD_GUILD_ID'),
    alertChannelId: optional('DISCORD_ALERT_CHANNEL_ID'),
    killChannelId: optional('DISCORD_KILL_CHANNEL_ID'),
  };

  if (missing.length) throw new ConfigError(`Missing required settings: ${missing.join(', ')} (see .env.example)`);
  if (!/^\d+\.\d$/.test(tripwire.maskId)) {
    throw new ConfigError(`TRIPWIRE_MASK_ID must look like 12345678.2 (got "${tripwire.maskId}")`);
  }
  if (!/^https?:\/\//.test(tripwire.url)) throw new ConfigError('TRIPWIRE_URL must start with http:// or https://');

  const pollRaw = env.POLL_SECONDS?.trim();
  const pollSeconds = pollRaw ? Number(pollRaw) : 60;
  if (!Number.isFinite(pollSeconds) || pollSeconds < 10) throw new ConfigError('POLL_SECONDS must be a number of at least 10');

  const friendlyIds = (env.FRIENDLY_IDS ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  const idList = (name: string) => (env[name] ?? '').split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
  const flag = (name: string, dflt: boolean) => {
    const v = env[name]?.trim().toLowerCase();
    if (!v) return dflt;
    return !['off', 'false', '0', 'no'].includes(v);
  };
  const killRaw = (env.KILL_ALERTS ?? 'jspace').trim().toLowerCase();
  const killAlerts: Config['killAlerts'] = ['off', 'false', '0', 'no'].includes(killRaw) ? 'off' : ['all', 'kspace', 'everything'].includes(killRaw) ? 'all' : 'jspace';

  return {
    discord,
    tripwire,
    friendlyIds,
    allowedRoleIds: idList('ALLOWED_ROLE_IDS'),
    allowedChannelIds: idList('ALLOWED_CHANNEL_IDS'),
    ephemeral: flag('EPHEMERAL_REPLIES', false),
    killAlerts,
    homeSystems: (env.HOME_SYSTEMS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    pollSeconds,
    stateFile: env.STATE_FILE?.trim() || '.trippy/state.json',
  };
}
