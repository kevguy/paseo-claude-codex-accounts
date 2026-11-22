import assert from "node:assert/strict";
import test from "node:test";
import { matchRule, normalizeRulePattern, ruleMatches, type PathContext, type ProjectRule } from "../server/rules";

const linux: PathContext = { homedir: "/home/alex", platform: "linux" };
const win: PathContext = { homedir: "C:\\Users\\Alex", platform: "win32" };

test("absolute POSIX patterns normalize duplicate separators", () => {
  assert.equal(normalizeRulePattern("/work///repo", linux), "/work/repo");
});
test("absolute POSIX patterns normalize dot segments", () => {
  assert.equal(normalizeRulePattern("/work/./repo", linux), "/work/repo");
});
test("absolute POSIX patterns normalize parent segments", () => {
  assert.equal(normalizeRulePattern("/work/team/../repo", linux), "/work/repo");
});
test("POSIX normalization removes a trailing separator", () => {
  assert.equal(normalizeRulePattern("/work/repo/", linux), "/work/repo");
});
test("tilde alone expands to the home folder", () => {
  assert.equal(normalizeRulePattern("~", linux), "/home/alex");
});
test("tilde slash expands to a path under home", () => {
  assert.equal(normalizeRulePattern("~/work", linux), "/home/alex/work");
});
test("tilde backslash is not a POSIX home separator", () => {
  assert.equal(normalizeRulePattern("~\\work", linux), null);
});
test("tilde backslash expands on Windows", () => {
  assert.equal(normalizeRulePattern("~\\work", win), "c:/users/alex/work");
});
test("tilde slash expands on Windows", () => {
  assert.equal(normalizeRulePattern("~/work", win), "c:/users/alex/work");
});
test("Windows drive and slash styles normalize to lowercase forward slashes", () => {
  assert.equal(normalizeRulePattern("C:/Work\\Repo/", win), "c:/work/repo");
});
test("Windows parent segments normalize", () => {
  assert.equal(normalizeRulePattern("c:\\work\\team\\..\\repo", win), "c:/work/repo");
});
test("Windows UNC paths normalize", () => {
  assert.equal(normalizeRulePattern("\\\\Server\\Share\\work\\..\\repo", win), "//server/share/repo");
});
test("empty patterns are invalid", () => {
  assert.equal(normalizeRulePattern("", linux), null);
});
test("whitespace-only patterns are invalid", () => {
  assert.equal(normalizeRulePattern("   ", linux), null);
});
test("spaces inside absolute path names are preserved", () => {
  assert.equal(normalizeRulePattern("/work/folder ", linux), "/work/folder ");
});
test("relative patterns are invalid", () => {
  assert.equal(normalizeRulePattern("work/repo", linux), null);
});
test("drive-relative Windows patterns are invalid", () => {
  assert.equal(normalizeRulePattern("C:work", win), null);
});
test("named-home patterns are invalid", () => {
  assert.equal(normalizeRulePattern("~alex/work", linux), null);
});
test("patterns containing NUL are invalid", () => {
  assert.equal(normalizeRulePattern("/work/\0repo", linux), null);
});
test("a plain folder matches itself", () => {
  assert.equal(ruleMatches("/work/repo", "/work/repo", linux), true);
});
test("a plain folder matches descendants", () => {
  assert.equal(ruleMatches("/work/repo", "/work/repo/src/main.ts", linux), true);
});
test("a parent folder does not match a similarly prefixed sibling", () => {
  assert.equal(ruleMatches("/work/repo", "/work/repository", linux), false);
});
test("POSIX path comparison is case-sensitive", () => {
  assert.equal(ruleMatches("/work/repo", "/Work/repo", linux), false);
});
test("a relative cwd never matches", () => {
  assert.equal(ruleMatches("/work", "work/project", linux), false);
});
test("single star matches characters within one segment", () => {
  assert.equal(ruleMatches("/work/*/src", "/work/team/src", linux), true);
});
test("single star does not consume a path separator", () => {
  assert.equal(ruleMatches("/work/*/src", "/work/team/deep/src", linux), false);
});
test("single-star folder matches descendants under the selected segment", () => {
  assert.equal(ruleMatches("/work/*", "/work/team/src", linux), true);
});
test("double star matches zero segments", () => {
  assert.equal(ruleMatches("/work/**/src", "/work/src", linux), true);
});
test("double star matches multiple segments", () => {
  assert.equal(ruleMatches("/work/**/src", "/work/team/deep/src", linux), true);
});
test("a trailing globstar is equivalent to its folder", () => {
  assert.equal(normalizeRulePattern("/work/repo/**", linux), "/work/repo");
  assert.equal(ruleMatches("/work/repo/**", "/work/repo/src", linux), true);
});
test("regex punctuation in a path is treated literally", () => {
  assert.equal(ruleMatches("/work/a+b (1)/repo", "/work/a+b (1)/repo", linux), true);
});
test("a regex-looking path cannot inject an alternative", () => {
  assert.equal(ruleMatches("/work/(team|public)", "/work/public", linux), false);
});
test("normalized parent tricks cannot escape the intended folder", () => {
  assert.equal(ruleMatches("/work/project/../secret", "/work/project/src", linux), false);
  assert.equal(ruleMatches("/work/project/../secret", "/work/secret/src", linux), true);
});
test("cwd parent segments are normalized before comparison", () => {
  assert.equal(ruleMatches("/work/repo", "/work/other/../repo/src", linux), true);
});
test("Windows matching is case-insensitive", () => {
  assert.equal(ruleMatches("C:\\Work\\Repo", "c:\\work\\REPO\\src", win), true);
});
test("Windows drive letters compare case-insensitively", () => {
  assert.equal(ruleMatches("c:\\work", "C:/work/project", win), true);
});
test("Windows accepts either separator in a cwd", () => {
  assert.equal(ruleMatches("C:/work/repo", "C:\\work/repo\\src", win), true);
});
test("Windows prefix boundaries remain safe", () => {
  assert.equal(ruleMatches("C:\\work\\repo", "C:\\work\\repository", win), false);
});
test("Windows UNC matching works", () => {
  assert.equal(ruleMatches("\\\\Server\\Share\\work", "//server/share/work/project", win), true);
});

const rules: ProjectRule[] = [
  { pattern: "/work", accountId: "broad" },
  { pattern: "/work/team", accountId: "team" },
  { pattern: "/work/team/app", accountId: "app" },
];

test("the most specific matching folder wins", () => {
  assert.equal(matchRule(rules, "/work/team/app/src", linux)?.accountId, "app");
});
test("a less nested path selects the less specific matching rule", () => {
  assert.equal(matchRule(rules, "/work/team/docs", linux)?.accountId, "team");
});
test("equal specificity ties go to the earlier rule", () => {
  const tied = [
    { pattern: "/work/*a", accountId: "first" },
    { pattern: "/work/a*", accountId: "second" },
  ];
  assert.equal(matchRule(tied, "/work/aa", linux)?.accountId, "first");
});
test("specificity counts literal characters after normalization", () => {
  const selected = matchRule([
    { pattern: "/work/./team/**", accountId: "normalized-specific" },
    { pattern: "/work/*", accountId: "wildcard" },
  ], "/work/team/project", linux);
  assert.equal(selected?.accountId, "normalized-specific");
});
test("no match returns null", () => {
  assert.equal(matchRule(rules, "/elsewhere", linux), null);
});
test("invalid rules are skipped", () => {
  assert.equal(matchRule([{ pattern: "relative", accountId: "invalid" }, ...rules], "/work/team", linux)?.accountId, "team");
});
