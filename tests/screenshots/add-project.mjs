// Registers a demo project with the fixture daemon. Usage: node add-project.mjs <asarRoot> <paseoHome> <cwd>
const [R, home, cwd] = process.argv.slice(2);
const { connectToDaemon } = await import(R + "/node_modules/@getpaseo/cli/dist/utils/client.js");
const client = await connectToDaemon({ target: { kind: "home", home } });
const out = await (client.openProject ?? client.addProject).call(client, cwd);
console.log(JSON.stringify(out).slice(0, 300));
await client.close?.(); process.exit(0);
