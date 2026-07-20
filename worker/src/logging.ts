// SPDX-License-Identifier: Apache-2.0
/// <reference types="node" />
/** Structured ASCII-only logging for Worker Next. */

const enum Level {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LEVEL_LABEL: Record<Level, string> = {
  [Level.DEBUG]: "DEBUG",
  [Level.INFO]: "INFO",
  [Level.WARN]: "WARN",
  [Level.ERROR]: "ERROR",
};

const LEVEL_CHAR: Record<Level, string> = {
  [Level.DEBUG]: "D",
  [Level.INFO]: "I",
  [Level.WARN]: "W",
  [Level.ERROR]: "E",
};

function isoNow(): string {
  return new Date().toISOString();
}

export class Logger {
  private _minLevel: Level = Level.INFO;

  constructor(readonly name: string) {}

  setLevel(level: "debug" | "info" | "warn" | "error"): void {
    const map: Record<string, Level> = {
      debug: Level.DEBUG,
      info: Level.INFO,
      warn: Level.WARN,
      error: Level.ERROR,
    };
    this._minLevel = map[level] ?? Level.INFO;
  }

  debug(msg: string, ...args: unknown[]): void {
    this._log(Level.DEBUG, msg, args);
  }

  info(msg: string, ...args: unknown[]): void {
    this._log(Level.INFO, msg, args);
  }

  warn(msg: string, ...args: unknown[]): void {
    this._log(Level.WARN, msg, args);
  }

  error(msg: string, ...args: unknown[]): void {
    this._log(Level.ERROR, msg, args);
  }

  private _log(level: Level, msg: string, args: unknown[]): void {
    if (level < this._minLevel) return;
    const line = args.length > 0 ? this._format(msg, args) : msg;
    const output = `${isoNow()} ${LEVEL_CHAR[level]} [${this.name}] ${line}`;
    if (level >= Level.ERROR) {
      process.stderr.write(output + "\n");
    } else {
      process.stdout.write(output + "\n");
    }
  }

  private _format(msg: string, args: unknown[]): string {
    let i = 0;
    return msg.replace(/%[sdo]/g, () => {
      const val = args[i++];
      if (val === undefined) return "<undefined>";
      if (val === null) return "<null>";
      if (typeof val === "object") {
        try {
          return JSON.stringify(val);
        } catch {
          return String(val);
        }
      }
      return String(val);
    });
  }
}

/** Convenience root logger. */
export const log = new Logger("worker-next");
