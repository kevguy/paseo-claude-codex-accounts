// Serves Paseo's bundled web app with a single-page fallback. Usage: node serve-app.mjs <root> <port>
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
const [root, port] = [process.argv[2], Number(process.argv[3])];
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".woff2": "font/woff2", ".wasm": "application/wasm" };
createServer(async (req, res) => {
  let path;
  try {
    path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  } catch {
    return res.writeHead(400).end();
  }
  let file = join(root, path);
  let body = await readFile(file).catch(() => null);
  if (!body) { file = join(root, "index.html"); body = await readFile(file); }
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(body);
}).listen(port, "127.0.0.1");
