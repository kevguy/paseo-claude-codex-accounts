/// <reference types="node" />
import { posix, win32 } from "node:path";

export interface ProjectRule {
  pattern: string;
  accountId: string;
}

export interface PathContext {
  homedir: string;
  platform: NodeJS.Platform;
}

function pathApi(ctx: PathContext) {
  return ctx.platform === "win32" ? win32 : posix;
}

/** Expands only the home shorthand and removes path syntax that has no matching significance. */
export function normalizeRulePattern(pattern: string, ctx: PathContext): string | null {
  if (typeof pattern !== "string" || !pattern.trim() || pattern.includes("\0")) return null;
  const api = pathApi(ctx);
  let value = pattern;

  if (value === "~" || value.startsWith("~/") || (ctx.platform === "win32" && value.startsWith("~\\"))) {
    const suffix = value === "~" ? "" : value.slice(2);
    if (!api.isAbsolute(ctx.homedir)) return null;
    value = api.join(ctx.homedir, suffix);
  } else if (value.startsWith("~")) {
    return null;
  }

  if (!api.isAbsolute(value)) return null;
  value = api.normalize(value);
  const root = api.parse(value).root;
  while (value.length > root.length && /[\\/]$/.test(value)) value = value.slice(0, -1);

  // On Windows both slash styles are accepted. Lowercasing makes drive letters and
  // the rest of the path follow Windows' case-insensitive path comparison.
  if (ctx.platform === "win32") value = value.replace(/\\/g, "/").toLowerCase();
  // macOS volumes are case-insensitive unless formatted otherwise, so "~/Work" should match "~/work".
  else if (ctx.platform === "darwin") value = value.toLowerCase();

  // A trailing globstar adds no restriction: a plain folder already covers its descendants.
  if (value.endsWith("/**")) value = value.slice(0, -3) || "/";
  return value;
}

function regexEscape(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

function ruleRegex(normalizedPattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < normalizedPattern.length; i++) {
    const char = normalizedPattern[i]!;
    if (char === "*" && normalizedPattern[i + 1] === "*") {
      if (normalizedPattern[i + 2] === "/") {
        // A globstar directory can consume zero segments, including its following slash.
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i++;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += regexEscape(char);
    }
  }
  // Rules select folders, so a match also covers paths below the selected folder.
  source += normalizedPattern.endsWith("/") ? ".*$" : "(?:/.*)?$";
  return new RegExp(source);
}

function normalizedCwd(cwd: string, ctx: PathContext): string | null {
  if (!cwd || cwd.includes("\0")) return null;
  const api = pathApi(ctx);
  if (!api.isAbsolute(cwd)) return null;
  const normalized = api.normalize(cwd);
  if (ctx.platform === "win32") return normalized.replace(/\\/g, "/").toLowerCase();
  return ctx.platform === "darwin" ? normalized.toLowerCase() : normalized;
}

export function ruleMatches(pattern: string, cwd: string, ctx: PathContext): boolean {
  const normalizedPattern = normalizeRulePattern(pattern, ctx);
  const normalizedPath = normalizedCwd(cwd, ctx);
  if (normalizedPattern === null || normalizedPath === null) return false;
  return ruleRegex(normalizedPattern).test(normalizedPath);
}

export function matchRule<R extends ProjectRule>(rules: readonly R[], cwd: string, ctx: PathContext): R | null {
  let best: R | null = null;
  let bestSpecificity = -1;
  for (const rule of rules) {
    const normalized = normalizeRulePattern(rule.pattern, ctx);
    if (normalized === null || !ruleMatches(rule.pattern, cwd, ctx)) continue;
    const specificity = [...normalized].filter((char) => char !== "*").length;
    if (specificity > bestSpecificity) {
      best = rule;
      bestSpecificity = specificity;
    }
  }
  return best;
}
