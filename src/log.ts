export interface Logger {
  info: (msg: string, ...rest: unknown[]) => void;
  warn: (msg: string, ...rest: unknown[]) => void;
  error: (msg: string, ...rest: unknown[]) => void;
}

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export const log: Logger = {
  info: (msg, ...rest) => console.log(`${stamp()} INFO  ${msg}`, ...rest),
  warn: (msg, ...rest) => console.warn(`${stamp()} WARN  ${msg}`, ...rest),
  error: (msg, ...rest) => console.error(`${stamp()} ERROR ${msg}`, ...rest),
};

export const silentLog: Logger = { info: () => {}, warn: () => {}, error: () => {} };
