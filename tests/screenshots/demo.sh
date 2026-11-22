#!/bin/sh
# Rebuilds the fictional demo, runs an isolated Paseo daemon on 127.0.0.1:6791 and serves Paseo's
# bundled web app on 127.0.0.1:6792 for screenshots. macOS only (uses /Applications/Paseo.app).
# Usage, from the repo root:
#   tests/screenshots/demo.sh <extracted Paseo app.asar dir>   start (restarts a previous demo)
#   tests/screenshots/demo.sh --stop                           stop
set -eu
PASEO=/Applications/Paseo.app/Contents/Resources/bin/paseo
D="$PWD/.validation/demo"
RUN="$PWD/.validation/demo-run"

# Only stop processes this script started, and only if their command line still matches.
stop() {
  for name in daemon web; do
    [ -f "$RUN/$name.pid" ] || continue
    pid=$(cat "$RUN/$name.pid")
    case "$(ps -o command= -p "$pid" 2>/dev/null || true)" in
      *"$D/paseo-home"*|*serve-app.mjs*6792*)
        kill "$pid"
        # The daemon shuts its plugins down first; wait for it rather than racing a restart.
        tries=0
        while kill -0 "$pid" 2>/dev/null; do
          tries=$((tries + 1))
          if [ $tries -gt 40 ]; then echo "$name (pid $pid) didn't stop; try again" >&2; exit 1; fi
          sleep 0.5
        done ;;
    esac
    rm -f "$RUN/$name.pid"
  done
}
stop
[ "${1:-}" = "--stop" ] && exit 0
ASAR="$1"
for port in 6791 6792; do
  if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is in use by something this script didn't start; stop it first." >&2
    exit 1
  fi
done

# Your own accounts must never leak in: these variables would point the demo at real folders.
unset CLAUDE_CONFIG_DIR CODEX_HOME
mkdir -p "$RUN"
rm -rf .validation/demo-plugin && mkdir -p .validation/demo-plugin
cp -R paseo-plugin.json index.client.tsx index.server.ts client server shared package.json npm-shrinkwrap.json LICENSE .validation/demo-plugin/
node tests/screenshots/fixture.mjs .validation/demo .validation/demo-plugin > /dev/null
mkdir -p "$D/home/projects/acme-web"
# Its own (empty) repository, so the sidebar never shows this repo's branch.
[ -d "$D/home/projects/acme-web/.git" ] || HOME="$D/home" git -C "$D/home/projects/acme-web" init -q -b main
# Made-up usage readings for the screenshots; the fixture's logins are fictional and can't be read.
DEMO_USAGE='{"claude":{"usedPct":97,"summary":"5h 97% · wk 64%"},"claude-work":{"usedPct":31,"summary":"5h 12% · wk 31%"},"claude-client-a":{"usedPct":58,"summary":"5h 58% · wk 40%"},"codex":{"usedPct":20,"summary":"5h 20% · wk 9%"},"codex-work":{"usedPct":44,"summary":"5h 44% · wk 25%"}}'
HOME="$D/home" PASEO_HOME="$D/paseo-home" PASEO_ACCOUNTS_DEMO_USAGE="$DEMO_USAGE" nohup "$PASEO" daemon run --home "$D/paseo-home" > "$D/daemon.log" 2>&1 &
echo $! > "$RUN/daemon.pid"
for i in $(seq 1 30); do grep -q "Plugin ready" "$D/daemon.log" 2>/dev/null && break; sleep 1; done
HOME="$D/home" node tests/screenshots/add-project.mjs "$ASAR" "$D/paseo-home" "$D/home/projects/acme-web" > /dev/null
nohup node tests/screenshots/serve-app.mjs /Applications/Paseo.app/Contents/Resources/app-dist 6792 > "$D/web.log" 2>&1 &
echo $! > "$RUN/web.pid"
echo "demo ready: daemon 127.0.0.1:6791, web app 127.0.0.1:6792"
