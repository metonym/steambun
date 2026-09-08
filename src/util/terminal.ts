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

export function getLogLevel(): LogLevel {
  return currentLevel;
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

/**
 * Explicit, testable equivalent of Bun.color's own NO_COLOR/FORCE_COLOR/TTY
 * heuristic — `paint()` consults this itself so tests stay deterministic
 * regardless of Bun's implicit check.
 */
export function colorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0")
    return true;
  return !!process.stdout.isTTY;
}

export function paint(text: string, color: string): string {
  if (!colorEnabled()) return text;
  const code = Bun.color(color, "ansi");
  if (!code) return text;
  return `${code}${text}\x1b[0m`;
}

function asciiGlyphs(): boolean {
  return process.env.TERM === "dumb" || !process.stdout.isTTY;
}

export function ok(text: string): string {
  const glyph = asciiGlyphs() ? "OK" : paint("✓", "green");
  return `${glyph} ${text}`;
}

export function warn(text: string): string {
  const glyph = asciiGlyphs() ? "!!" : paint("!", "yellow");
  return `${glyph} ${text}`;
}

export function fail(text: string): string {
  const glyph = asciiGlyphs() ? "XX" : paint("✗", "red");
  return `${glyph} ${text}`;
}

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
