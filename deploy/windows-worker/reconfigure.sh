#!/usr/bin/env bash
set -euo pipefail

FIREBIRD_CONFIG=/opt/dataexpress/runtime/firebird5/firebird.conf
SOURCE_CONFIG=/etc/dataexpress/dxwebsrv.cfg
RUNTIME_ROOT=/opt/dataexpress-wine/current
INSTANCES_ROOT=/var/lib/dataexpress-wine/instances
SHARED_EXTENSIONS=/var/lib/dataexpress/extensions
MANIFEST="$INSTANCES_ROOT/instances.json"
ROUTES=/etc/nginx/snippets/dataexpress-worker-routes.conf

if [ "$(id -u)" -ne 0 ]; then
  echo "The worker reconfiguration must run as root." >&2
  exit 1
fi
if [ ! -f "$SOURCE_CONFIG" ] || [ ! -f "$FIREBIRD_CONFIG" ] ||
   [ ! -f "$RUNTIME_ROOT/dxwebsrv.exe" ]; then
  echo "Install the main service and Wine worker runtime first." >&2
  exit 1
fi

sed -i -E \
  -e 's|^[#[:space:]]*RemoteServicePort[[:space:]]*=.*|RemoteServicePort = 3050|' \
  -e 's|^[#[:space:]]*RemoteBindAddress[[:space:]]*=.*|RemoteBindAddress = 127.0.0.1|' \
  -e 's|^[#[:space:]]*ServerMode[[:space:]]*=.*|ServerMode = Super|' \
  "$FIREBIRD_CONFIG"

install -d -m 0750 -o dataexpress -g dataexpress "$INSTANCES_ROOT"
python3 /opt/dataexpress-wine/bin/configure.py \
  --source "$SOURCE_CONFIG" \
  --instances-root "$INSTANCES_ROOT" \
  --manifest "$MANIFEST" \
  --routes "$ROUTES" \
  --base-port 18180 \
  --firebird-host 127.0.0.1 \
  --data-root /var/lib/dataexpress

mapfile -t INSTANCE_ROWS < <(
  python3 - "$MANIFEST" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    for item in json.load(stream)["instances"]:
        print(f'{item["instance"]}\t{item["alias"]}\t{item["port"]}')
PY
)
if [ "${#INSTANCE_ROWS[@]}" -eq 0 ]; then
  echo "The DataExpress config has no database instances." >&2
  exit 1
fi

declare -A EXPECTED_UNITS=()
for row in "${INSTANCE_ROWS[@]}"; do
  IFS=$'\t' read -r instance alias port <<<"$row"
  EXPECTED_UNITS["dataexpress-wine-worker@$instance.service"]=1
done

systemctl stop dataexpress-wine-worker.service 2>/dev/null || true
while read -r unit _; do
  [ -n "$unit" ] && systemctl stop "$unit" 2>/dev/null || true
done < <(
  systemctl list-units --all --plain --no-legend 'dataexpress-wine-worker@*.service' || true
)
while read -r unit _; do
  [ -z "$unit" ] && continue
  if [ -z "${EXPECTED_UNITS[$unit]+configured}" ]; then
    systemctl disable --now "$unit" 2>/dev/null || true
  fi
done < <(
  systemctl list-unit-files --type=service --no-legend \
    'dataexpress-wine-worker@*.service' || true
)

for row in "${INSTANCE_ROWS[@]}"; do
  IFS=$'\t' read -r instance alias port <<<"$row"
  INSTANCE_ROOT="$INSTANCES_ROOT/$instance"
  PREFIX="$INSTANCE_ROOT/prefix"
  APP_DIR="$PREFIX/drive_c/dataexpress"
  CONFIG="$INSTANCE_ROOT/dxwebsrv.cfg"
  CACHE="$INSTANCE_ROOT/cache"

  install -d -m 0750 -o dataexpress -g dataexpress "$PREFIX" "$CACHE"
  if [ ! -d "$PREFIX/drive_c" ]; then
    runuser -u dataexpress -- env \
      WINEPREFIX="$PREFIX" WINEARCH=win64 WINEDEBUG=-all \
      HOME="$INSTANCE_ROOT" XDG_CACHE_HOME="$CACHE" \
      WINEDLLOVERRIDES='mscoree,mshtml=' \
      xvfb-run -a wineboot -u
  fi

  install -d -m 0750 -o dataexpress -g dataexpress "$APP_DIR"
  cp -a "$RUNTIME_ROOT/." "$APP_DIR/"
  install -m 0640 -o dataexpress -g dataexpress "$CONFIG" "$APP_DIR/dxwebsrv.cfg"

  DOS_DEVICES="$PREFIX/dosdevices"
  install -d -m 0750 -o dataexpress -g dataexpress "$DOS_DEVICES"
  rm -f "$DOS_DEVICES/z:"
  ln -sfn /var/lib/dataexpress "$DOS_DEVICES/d:"
  chown -h dataexpress:dataexpress "$DOS_DEVICES/d:"

  python3 /opt/dataexpress-wine/bin/stage_bundle.py \
    --source "$SHARED_EXTENSIONS/$alias" \
    --app-dir "$APP_DIR" \
    --alias "$alias" \
    >"$INSTANCE_ROOT/extension-compatibility.json"
  chown -R dataexpress:dataexpress "$INSTANCE_ROOT"
  chmod 0640 "$INSTANCE_ROOT/extension-compatibility.json"
  echo "Prepared isolated worker $instance for $alias on 127.0.0.1:$port"
done

chown root:root "$ROUTES"
chmod 0644 "$ROUTES"
nginx -t

systemctl stop dataexpress-web.service
systemctl restart dataexpress-firebird.service
for row in "${INSTANCE_ROWS[@]}"; do
  IFS=$'\t' read -r instance alias port <<<"$row"
  systemctl enable "dataexpress-wine-worker@$instance.service"
  systemctl restart "dataexpress-wine-worker@$instance.service"
done
systemctl start dataexpress-web.service
systemctl reload nginx.service

for row in "${INSTANCE_ROWS[@]}"; do
  IFS=$'\t' read -r instance alias port <<<"$row"
  ready=0
  for _ in $(seq 1 60); do
    if curl --fail --silent "http://127.0.0.1:$port/health" |
       grep -q '"status":"ok"'; then
      ready=1
      break
    fi
    sleep 1
  done
  if [ "$ready" -ne 1 ]; then
    systemctl --no-pager --full status \
      "dataexpress-wine-worker@$instance.service" >&2 || true
    exit 1
  fi
done

echo "All per-database DataExpress Wine workers are healthy."
