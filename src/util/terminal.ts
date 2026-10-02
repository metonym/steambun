export type LogLevel = "silent" | "error" | "warn" | "info";

const LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function logAt(level: LogLevel, print: (msg: string) => void, msg: string) {
  if (LEVEL_RANK[level] <= LEVEL_RANK[currentLevel]) print(msg);
}

export const log = {
  info(msg: string): void {
    logAt("info", console.log, msg);
  },
  warn(msg: string): void {
    logAt("warn", console.warn, msg);
  },
  error(msg: string): void {
    logAt("error", console.error, msg);
  },
};

// Checked here rather than left to Bun.color's implicit heuristic so tests stay deterministic.
function colorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0")
    return true;
  return !!process.stdout.isTTY;
}

function paint(text: string, color: string): string {
  if (!colorEnabled()) return text;
  return `${Bun.color(color, "ansi") ?? ""}${text}\x1b[0m`;
}

const status = (ascii: string, symbol: string, color: string) => {
  return (text: string): string => {
    const dumb = process.env.TERM === "dumb" || !process.stdout.isTTY;
    return `${dumb ? ascii : paint(symbol, color)} ${text}`;
  };
};

export const ok = status("OK", "✓", "green");
export const warn = status("!!", "!", "yellow");
export const fail = status("XX", "✗", "red");

export function pad(
  text: string,
  width: number,
  align: "start" | "end" = "end",
): string {
  const visibleWidth = Bun.stringWidth(text);
  if (visibleWidth >= width) return text;
  const padding = " ".repeat(width - visibleWidth);
  return align === "start" ? padding + text : text + padding;
}
