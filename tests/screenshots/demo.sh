#!/bin/sh
# Rebuilds the fictional demo, runs an isolated Paseo daemon on 127.0.0.1:6791 and serves Paseo's
# bundled web app on 127.0.0.1:6792 for screenshots. Stop both with: kill $(lsof -t -iTCP:6791 -iTCP:6792 -sTCP:LISTEN)
# Usage: tests/screenshots/demo.sh <extracted Paseo app.asar dir>   (run from the repo root)
set -eu
ASAR="$1"
PASEO=/Applications/Paseo.app/Contents/Resources/bin/paseo
D="$PWD/.validation/demo"
for pid in $(lsof -nP -iTCP:6791 -iTCP:6792 -sTCP:LISTEN -t 2>/dev/null); do kill "$pid"; done
pkill -f "daemon run --home $D/paseo-home" 2>/dev/null || true
sleep 2
rm -rf .validation/demo-plugin && mkdir -p .validation/demo-plugin
cp -R paseo-plugin.json index.client.tsx index.server.ts client server shared package.json npm-shrinkwrap.json LICENSE .validation/demo-plugin/
node tests/screenshots/fixture.mjs .validation/demo .validation/demo-plugin > /dev/null
mkdir -p "$D/home/projects/acme-web"
(cd "$D" && HOME="$D/home" PASEO_HOME="$D/paseo-home" nohup "$PASEO" daemon run --home "$D/paseo-home" > daemon.log 2>&1 &)
for i in $(seq 1 30); do grep -q "Plugin ready" "$D/daemon.log" 2>/dev/null && break; sleep 1; done
HOME="$D/home" node tests/screenshots/add-project.mjs "$ASAR" "$D/paseo-home" "$D/home/projects/acme-web" > /dev/null
(nohup node tests/screenshots/serve-app.mjs /Applications/Paseo.app/Contents/Resources/app-dist 6792 > "$D/web.log" 2>&1 &)
echo "demo ready: daemon 127.0.0.1:6791, web app 127.0.0.1:6792"
