/**
 * A Windows .cmd shim only runs through cmd.exe, which treats & | < > ^ % ! " and parentheses as
 * syntax even inside arguments. Node passes arguments to it unquoted, so anything handed to a shim
 * must be plain text. Every argument the sign-in modules pass is checked here before spawning.
 */
const PLAIN = /^[A-Za-z0-9._+\-@:\\/=,]+$/;

export function assertPlainShellArgs(args: readonly string[]): void {
  for (const arg of args) {
    if (!PLAIN.test(arg)) throw new Error("That can't be passed safely to the CLI on Windows. Use letters, digits and . _ + - @ only, or sign in from a terminal.");
  }
}
