// Drives Paseo's web app against the fixture daemon in a throwaway headless Chromium profile and
// saves the README screenshots. Usage: node capture.mjs <playwright-core dir> <outDir>
const [pw, outDir] = process.argv.slice(2);
const { chromium } = await import(pw + "/index.mjs");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, colorScheme: "dark" });
await context.addInitScript(() => {
  globalThis.__PASEO_INITIAL_DAEMON_CONNECTION__ = { listen: "127.0.0.1:6791" };
});
const page = await context.newPage();
// Accounts lives in Settings. The demo daemon's id is in its Paseo home (tests/screenshots/demo.sh).
const { readFileSync } = await import("node:fs");
const serverId = readFileSync(".validation/demo/paseo-home/server-id", "utf8").trim();
await page.goto("http://127.0.0.1:6792/");
await page.waitForTimeout(3000);
// First-run setup shows only when the host has no projects yet.
const skip = page.getByText("Skip setup");
if (await skip.isVisible()) await skip.click();
await page.goto(`http://127.0.0.1:6792/settings/hosts/${serverId}/plugins/paseo-accounts/accounts`);
await page.getByText(/^Claude accounts/).waitFor({ timeout: 20000 });
await page.waitForTimeout(1500);
console.log("URL", page.url());
// Shots show the settings column only: the sidebar names the real machine (macOS ComputerName).
const left = (await page.getByText("Back to plugins").boundingBox()).x - 28;
const size = page.viewportSize();
const column = (y) => ({ x: left, y, width: size.width - left, height: size.height - y });
await page.screenshot({ path: `${outDir}/accounts.png`, clip: column(0) });
// Open one signed-in account's options for the second shot.
await page.getByTestId("account-codex-work").getByRole("button", { name: /Show options/ }).click();
await page.waitForTimeout(500);
const top = (locator) => locator.evaluate((element) => element.scrollIntoView({ block: "start" }));
await top(page.getByText(/^Codex accounts/));
await page.waitForTimeout(500);
await page.screenshot({ path: `${outDir}/accounts-codex.png`, clip: column(0) });
await page.getByPlaceholder("Work").fill("Client B");
await top(page.getByText("Add an account", { exact: true }));
await page.waitForTimeout(500);
const heading = await page.getByText("Add an account", { exact: true }).boundingBox();
// Stop above Paseo's own "Details" section, whose Source row shows the plugin's real folder.
const details = await page.getByText("Details", { exact: true }).boundingBox();
const addClip = column(heading.y - 16);
await page.screenshot({ path: `${outDir}/accounts-add.png`, clip: { ...addClip, height: Math.min(addClip.height, details.y - 24 - addClip.y) } });

// Check the real flow on the fixture: add the account, see its card, then remove it in two steps.
await page.getByText("Add account", { exact: true }).click();
await page.getByText("Claude (Client B)", { exact: true }).waitFor({ timeout: 10000 });
console.log("ADD ok:", await page.getByText(/Claude \(Client B\) added/).count() > 0 ? "card + toast" : "card");
const card = page.getByTestId("account-claude-client-b");
console.log("NEW CARD:", (await card.innerText()).replace(/\n+/g, " | ").slice(0, 300));
await card.getByText("Remove…", { exact: true }).click();
await card.getByText("Remove", { exact: true }).click();
await page.getByText("Claude (Client B)", { exact: true }).waitFor({ state: "detached", timeout: 10000 });
console.log("REMOVE ok");

// The same screen as a workspace tab: open the demo workspace, then + → Accounts.
await page.goto("http://127.0.0.1:6792/");
await page.getByText("main", { exact: true }).first().click({ timeout: 20000 });
await page.waitForTimeout(2000);
await page.getByRole("button", { name: "New tab" }).first().click();
await page.waitForTimeout(800);
await page.getByText("Accounts", { exact: true }).last().click();
await page.getByText(/^Claude accounts/).waitFor({ timeout: 15000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${outDir}/accounts-panel.png` });
console.log("PANEL ok");
await browser.close();
