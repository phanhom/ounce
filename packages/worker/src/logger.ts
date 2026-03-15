export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  // Levels
  debug: "\x1b[90m",       // gray
  info: "\x1b[36m",        // cyan
  warn: "\x1b[33m",        // yellow
  error: "\x1b[31m",       // red
  // Categories
  ws: "\x1b[35m",          // magenta
  beacon: "\x1b[34m",      // blue
  exec: "\x1b[32m",        // green
  pair: "\x1b[33m",        // yellow
  system: "\x1b[36m",      // cyan
  success: "\x1b[32m",     // green
  fail: "\x1b[31m",        // red
};

const LEVEL_BADGES: Record<LogLevel, string> = {
  debug: `${COLORS.debug}DBG${COLORS.reset}`,
  info:  `${COLORS.info}INF${COLORS.reset}`,
  warn:  `${COLORS.warn}WRN${COLORS.reset}`,
  error: `${COLORS.error}ERR${COLORS.reset}`,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${COLORS.dim}${hh}:${mm}:${ss}.${ms}${COLORS.reset}`;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function fmt(level: LogLevel, tag: string, color: string, msg: string, extra?: string): string {
  const tagStr = `${color}${tag.padEnd(7)}${COLORS.reset}`;
  const extraStr = extra ? ` ${COLORS.dim}${extra}${COLORS.reset}` : "";
  return `${ts()} ${LEVEL_BADGES[level]} ${tagStr} ${msg}${extraStr}`;
}

// ── Public API ──────────────────────────────────────────────────────────

export const log = {
  debug(tag: string, msg: string, extra?: string): void {
    if (!shouldLog("debug")) return;
    console.log(fmt("debug", tag, COLORS.debug, msg, extra));
  },

  info(tag: string, msg: string, extra?: string): void {
    if (!shouldLog("info")) return;
    console.log(fmt("info", tag, COLORS.info, msg, extra));
  },

  warn(tag: string, msg: string, extra?: string): void {
    if (!shouldLog("warn")) return;
    console.warn(fmt("warn", tag, COLORS.warn, msg, extra));
  },

  error(tag: string, msg: string, extra?: string): void {
    if (!shouldLog("error")) return;
    console.error(fmt("error", tag, COLORS.error, msg, extra));
  },

  // Specialized loggers with semantic coloring

  ws(level: LogLevel, msg: string, extra?: string): void {
    if (!shouldLog(level)) return;
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn(fmt(level, "ws", COLORS.ws, msg, extra));
  },

  beacon(level: LogLevel, msg: string, extra?: string): void {
    if (!shouldLog(level)) return;
    console.log(fmt(level, "beacon", COLORS.beacon, msg, extra));
  },

  exec(level: LogLevel, msg: string, extra?: string): void {
    if (!shouldLog(level)) return;
    const fn = level === "error" ? console.error : console.log;
    fn(fmt(level, "exec", COLORS.exec, msg, extra));
  },

  pair(level: LogLevel, msg: string, extra?: string): void {
    if (!shouldLog(level)) return;
    console.log(fmt(level, "pair", COLORS.pair, msg, extra));
  },

  /** Frames sent/received over WebSocket — only in debug mode */
  frame(direction: "<<" | ">>", frameType: string, extra?: string): void {
    if (!shouldLog("debug")) return;
    const arrow = direction === ">>" ? `${COLORS.success}>>${COLORS.reset}` : `${COLORS.ws}<<${COLORS.reset}`;
    const extraStr = extra ? ` ${COLORS.dim}${extra}${COLORS.reset}` : "";
    console.log(`${ts()} ${COLORS.dim}FRM${COLORS.reset} ${arrow} ${frameType}${extraStr}`);
  },

  /** Status line for the live status display */
  status(label: string, value: string, ok = true): void {
    const color = ok ? COLORS.success : COLORS.fail;
    const icon = ok ? "●" : "○";
    console.log(`  ${color}${icon}${COLORS.reset} ${label.padEnd(20)} ${value}`);
  },

  /** A blank separator line */
  separator(): void {
    console.log("");
  },
};
