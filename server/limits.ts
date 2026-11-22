/// <reference types="node" />
// Usage-limit message patterns adapted from ZeroSub (https://github.com/kapybara-org/zerosub,
// server/limits.ts), MIT License, Copyright (c) 2026 Kapybara. See THIRD_PARTY_NOTICES.md.

export type LimitKind = "claude" | "codex";

export interface LimitHit {
  scope: "session" | "weekly" | "model" | "spend" | "credits" | "unknown";
  model?: string;
  resetsAt?: number;
}

const APOSTROPHE = "['’]";
const CLAUDE = new RegExp(
  String.raw`^You${APOSTROPHE}(?:ve hit your (?:5-hour |session |weekly |Opus |Sonnet |Fable |Haiku |fast )?limit|ve reached your (?:Fable|Opus|Sonnet|Haiku)(?: [\w.]{1,16})? limit)(?=\s*(?:·|\.|$|for this week\b))`,
  "i",
);
const CLAUDE_BUDGET = new RegExp(
  String.raw`^You${APOSTROPHE}(?:ve hit your (?:usage limit|usage credit limit|team${APOSTROPHE}s (?:shared|pooled group) budget|(?:monthly|individual) spend limit|individual usage limit|(?:org|channel)${APOSTROPHE}s monthly (?:usage|spend) limit)|re out of (?:usage credits|extra usage))(?=\s*(?:·|\.|$))`,
  "i",
);
const CLAUDE_OTHER_BUDGET = /^(?:Your org is out of usage\s*·|Usage is paused for your organization\.|Your seat type doesn['’]t include (?:usage credits|extra usage|usage)\b|Your usage allocation has been disabled by your admin|Your group['’]s usage limit is set to \$0|Fable(?: [^·\n]{1,40})? requires usage credits\.)/i;
const LEGACY_CLAUDE = /Claude AI usage limit reached\|(\d{9,})/i;
const CODEX_WINDOW = new RegExp(`^You${APOSTROPHE}ve (?:hit|reached) your usage limit\\b`, "i");
const CODEX_CREDITS = /^Your workspace is out of credits\b/i;
const CODEX_SPEND = /^You hit your spend cap\b/i;
const CODEX_RAW = /"type"\s*:\s*"usage_limit_reached"/i;
const MODEL = new RegExp(`^You${APOSTROPHE}ve (?:hit|reached) your (Opus|Sonnet|Fable|Haiku|fast)\\b`, "i");

/** Detects a provider's actual exhausted-usage message without treating throttling as quota exhaustion. */
export function detectLimit(kind: LimitKind, message: string, now: Date, timeZone?: string): LimitHit | null {
  const text = message.trim();
  if (kind === "claude") {
    const legacy = text.match(LEGACY_CLAUDE);
    if (legacy) return { scope: "session", resetsAt: Number(legacy[1]) * 1000 };

    const line = text.split("\n", 1)[0]?.trim() ?? "";
    if (CLAUDE.test(line)) {
      const named = line.match(MODEL)?.[1];
      const lower = line.toLowerCase();
      const scope = named ? "model" : /weekly/.test(lower) ? "weekly" : "session";
      return withReset({ scope, ...(named ? { model: named.toLowerCase() } : {}) }, text, now, timeZone);
    }
    if (CLAUDE_BUDGET.test(line) || CLAUDE_OTHER_BUDGET.test(line)) {
      const scope = /credit|extra usage|out of usage|allocation|seat type/i.test(line) ? "credits" : "spend";
      return withReset({ scope }, text, now, timeZone);
    }
    return null;
  }

  if (CODEX_CREDITS.test(text)) return withReset({ scope: "credits" }, text, now, timeZone);
  if (CODEX_SPEND.test(text)) return withReset({ scope: "spend" }, text, now, timeZone);
  if (CODEX_WINDOW.test(text) || /^The usage limit has been reached\b/i.test(text) || CODEX_RAW.test(text)) {
    return withReset({ scope: "session" }, text, now, timeZone);
  }
  return null;
}

function withReset(hit: LimitHit, text: string, now: Date, timeZone?: string): LimitHit {
  const resetsAt = parseReset(text, now, timeZone);
  return resetsAt === undefined ? hit : { ...hit, resetsAt };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function parseReset(text: string, now: Date, fallbackZone?: string): number | undefined {
  const epoch = text.match(/(?:usage limit reached\||\b(?:epoch|reset(?:s)? at)\s*[:=]?\s*)(\d{9,13})\b/i);
  if (epoch?.[1]) {
    const value = Number(epoch[1]);
    return value < 100_000_000_000 ? value * 1000 : value;
  }

  const relative = text.match(/(?:try again|resets?)\s+in\s+(?:(\d+)\s+hours?)?(?:\s*(\d+)\s+minutes?)?/i);
  if (relative && (relative[1] || relative[2])) {
    return now.getTime() + (Number(relative[1] ?? 0) * 60 + Number(relative[2] ?? 0)) * 60_000;
  }

  const time = text.match(/(?:resets?\s+|try again at\s+|\bat\s+)(?:(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,?\s+(\d{4}))?[,]?\s*)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s*(?:\(([^)]+)\))?/i);
  if (!time) return undefined;
  const [, monthName, dayValue, yearValue, hourValue, minuteValue, meridiem, zoneValue] = time;
  const hour12 = Number(hourValue);
  if (hour12 < 1 || hour12 > 12) return undefined;
  const hour = (hour12 % 12) + (meridiem?.toLowerCase() === "p" ? 12 : 0);
  const minute = Number(minuteValue ?? 0);
  const month = monthName ? MONTHS.findIndex((name) => name === monthName.slice(0, 3).toLowerCase()) : null;
  const day = dayValue ? Number(dayValue) : null;
  const zone = validZone(zoneValue?.trim()) ?? validZone(fallbackZone) ?? "UTC";
  const parts = zonedParts(now.getTime(), zone);
  let year = yearValue ? Number(yearValue) : parts.year;
  let candidate = makeZonedInstant(year, month ?? parts.month, day ?? parts.day, hour, minute, zone);
  if (month !== null && day !== null && !yearValue && candidate <= now.getTime()) {
    year += 1;
    candidate = makeZonedInstant(year, month, day, hour, minute, zone);
  } else if (month === null && day === null && candidate <= now.getTime()) {
    candidate = makeZonedInstant(year, parts.month, parts.day + 1, hour, minute, zone);
  }
  return Number.isFinite(candidate) ? candidate : undefined;
}

function validZone(zone?: string): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

function zonedParts(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month") - 1, day: get("day"), hour: get("hour") % 24, minute: get("minute") };
}

function makeZonedInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const wall = Date.UTC(year, month, day, hour, minute);
  let guess = wall;
  for (let index = 0; index < 4; index += 1) {
    const seen = zonedParts(guess, timeZone);
    const delta = wall - Date.UTC(seen.year, seen.month, seen.day, seen.hour, seen.minute);
    if (delta === 0) break;
    guess += delta;
  }
  return guess;
}
