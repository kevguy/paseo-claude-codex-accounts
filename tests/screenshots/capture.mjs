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
await page.goto("http://127.0.0.1:6792/");
// First-run setup shows only when the host has no projects yet.
await page.getByText("Accounts", { exact: true }).first().waitFor({ timeout: 15000 });
await page.waitForTimeout(1500);
const skip = page.getByText("Skip setup");
if (await skip.isVisible()) await skip.click();
await page.waitForTimeout(800);
await page.getByText("Accounts", { exact: true }).first().click();
await page.getByText("Claude accounts").waitFor({ timeout: 15000 });
await page.waitForTimeout(1500);
console.log("URL", page.url());
await page.screenshot({ path: `${outDir}/accounts.png` });
// Open one signed-in account's options for the second shot.
await page.getByText("Codex (Work)").click();
await page.waitForTimeout(500);
const top = (locator) => locator.evaluate((element) => element.scrollIntoView({ block: "start" }));
await top(page.getByText(/^Codex accounts/));
await page.waitForTimeout(500);
const codexTitle = await page.getByText(/^Codex accounts/).boundingBox();
const size = page.viewportSize();
// Scrolled views show the content column only; the sidebar is in the first shot.
const column = (y) => ({ x: codexTitle.x - 12, y, width: size.width - codexTitle.x + 12, height: size.height - y });
await page.screenshot({ path: `${outDir}/accounts-codex.png`, clip: column(0) });
await page.getByPlaceholder("Work").fill("Client B");
await top(page.getByText("Add an account", { exact: true }));
await page.waitForTimeout(500);
const heading = await page.getByText("Add an account", { exact: true }).boundingBox();
await page.screenshot({ path: `${outDir}/accounts-add.png`, clip: column(heading.y - 16) });

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
await browser.close();
