import assert from "node:assert/strict";
import test from "node:test";
import { assertPlainShellArgs } from "../server/shell-args";

test("plain arguments pass", () => {
  assert.doesNotThrow(() => assertPlainShellArgs(["auth", "login", "--claudeai", "--email", "first.last+tag@example.co.uk", "C:\\Users\\a\\x", "app-server"]));
});

for (const bad of ["a&calc&@x.com", "x|y", "%PATH%", "a^b", "a<b", "a>b", "a\"b", "a!b", "(a)", "a b", "--package=x", "a,b", "a;b", ""]) {
  test(`refuses ${JSON.stringify(bad)}`, () => {
    assert.throws(() => assertPlainShellArgs(["auth", bad]), /safely/);
  });
}
