// Lists usage reports from a daemon, with emails redacted. Usage: node usage-probe.mjs <asarRoot> <paseoHome>
const [R, home] = process.argv.slice(2);
const { connectToDaemon } = await import(R + "/node_modules/@getpaseo/cli/dist/utils/client.js");
const client = await connectToDaemon({ target: { kind: "home", home } });
const reports = [];
await client.listUsageReports({ forceRefresh: true }, (report) => reports.push(report));
for (const r of reports) {
  const windows = r.report?.status === "available" ? r.report.windows.map((w) => `${w.label} ${Math.round(w.usedPct ?? 0)}%`).join(", ") : (r.report?.problem?.kind ?? r.report?.error ?? "");
  console.log([r.sourceId, r.sourceLabel, r.account?.label ?? "", r.report?.status, r.report?.planLabel ?? "", windows].join(" | ").replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]+/g, "<email>"));
}
await client.close?.(); process.exit(0);
