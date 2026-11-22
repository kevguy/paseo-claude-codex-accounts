import readline from "node:readline";
// Like the real `codex app-server` (0.158), messages carry no "jsonrpc" field.

const mode = process.argv[2] ?? "success";
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const loginId = "fixture-login";
let rpcId = 0;
let serverRequestId;
let serverRequestAnswered = false;
let queuedLogin;

function write(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function result(id, value) { write({ id, result: value }); }
function notify(method, params) { write({ method, params }); }

if (mode === "early-exit") {
  process.stderr.write("fatal token sk-abcdefghijklmnopqrstuvwxyz123456\n");
  process.exit(17);
}

input.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === "initialize") {
    if (mode === "env-check" && (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.CODEX_HOME == null || process.env.KEEP_ME !== "yes")) {
      write({ id: request.id, error: { code: -32000, message: "child environment was not sanitized" } });
      return;
    }
    result(request.id, { codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "linux", userAgent: "fixture" });
  } else if (request.method === "initialized") {
    if (mode === "unknown-request") {
      serverRequestId = ++rpcId;
      write({ id: serverRequestId, method: "client/unrecognized", params: {} });
    }
  } else if (request.method === "account/login/start") {
    if (mode === "unknown-request" && !serverRequestAnswered) {
      queuedLogin = request;
      return;
    }
    handleLoginStart(request);
  } else if (request.method === "account/read") {
    result(request.id, { requiresOpenaiAuth: false, account: { type: "chatgpt", email: "alex@example.com", planType: "plus" } });
  } else if (request.method === "account/login/cancel") {
    result(request.id, { status: "canceled" });
    setTimeout(() => process.exit(0), 5);
  } else if (request.id === serverRequestId) {
    serverRequestAnswered = request.error?.code === -32601;
    if (serverRequestAnswered && queuedLogin) {
      const queued = queuedLogin;
      queuedLogin = undefined;
      handleLoginStart(queued);
    }
  }
});

function handleLoginStart(request) {
  const device = request.params?.type === "chatgptDeviceCode";
  result(request.id, device
    ? { type: "chatgptDeviceCode", loginId, verificationUrl: "https://example.test/device", userCode: "ABCD-EFGH" }
    : { type: "chatgpt", loginId, authUrl: "https://example.test/auth" });
  if (mode === "failure") setTimeout(() => notify("account/login/completed", { loginId, success: false, error: "Authentication was canceled by the server" }), 5);
  if (mode === "device-disabled") setTimeout(() => notify("account/login/completed", { loginId, success: false, error: "Device-code authentication is disabled" }), 5);
  if (mode === "success" || mode === "unknown-request" || mode === "env-check") setTimeout(() => notify("account/login/completed", { loginId: "some-other-login", success: true }), 5);
  if (mode === "success" || mode === "unknown-request" || mode === "device-success" || mode === "env-check") setTimeout(() => notify("account/login/completed", { loginId, success: true }), 15);
}
