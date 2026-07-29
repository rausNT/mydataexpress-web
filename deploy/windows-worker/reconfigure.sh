#!/usr/bin/env bash
set -euo pipefail

FIREBIRD_CONFIG=/opt/dataexpress/runtime/firebird5/firebird.conf
SOURCE_CONFIG=/etc/dataexpress/dxwebsrv.cfg
WORKER_ROOT=/var/lib/dataexpress-wine/prefix/drive_c/dataexpress
WORKER_CONFIG="$WORKER_ROOT/dxwebsrv.cfg"
SHARED_EXTENSIONS=/var/lib/dataexpress/extensions
WORKER_EXTENSIONS="$WORKER_ROOT/extensions"
ROUTES=/etc/nginx/snippets/dataexpress-worker-routes.conf

if [ "$(id -u)" -ne 0 ]; then
  echo "The worker reconfiguration must run as root." >&2
  exit 1
fi
if [ ! -f "$SOURCE_CONFIG" ] || [ ! -f "$FIREBIRD_CONFIG" ]; then
  echo "Install the main DataExpress service first." >&2
  exit 1
fi

sed -i -E \
  -e 's|^[#[:space:]]*RemoteServicePort[[:space:]]*=.*|RemoteServicePort = 3050|' \
  -e 's|^[#[:space:]]*RemoteBindAddress[[:space:]]*=.*|RemoteBindAddress = 127.0.0.1|' \
  -e 's|^[#[:space:]]*ServerMode[[:space:]]*=.*|ServerMode = Super|' \
  "$FIREBIRD_CONFIG"

python3 /opt/dataexpress-wine/bin/configure.py \
  --source "$SOURCE_CONFIG" \
  --worker-config "$WORKER_CONFIG" \
  --routes "$ROUTES" \
  --port 8180 \
  --upstream 127.0.0.1:8180 \
  --firebird-host 127.0.0.1 \
  --data-root /var/lib/dataexpress

chown dataexpress:dataexpress "$WORKER_CONFIG"
chmod 0640 "$WORKER_CONFIG"
install -d -m 0750 -o dataexpress -g dataexpress "$WORKER_EXTENSIONS"
if [ -d "$SHARED_EXTENSIONS" ]; then
  while IFS= read -r -d '' extension; do
    relative="${extension#"$SHARED_EXTENSIONS"/}"
    install -d -m 0750 -o dataexpress -g dataexpress \
      "$(dirname "$WORKER_EXTENSIONS/$relative")"
    install -m 0640 -o dataexpress -g dataexpress "$extension" \
      "$WORKER_EXTENSIONS/$relative"
  done < <(
    find "$SHARED_EXTENSIONS" -mindepth 2 -type f -iname '*.wepas' -print0
  )
fi
chown root:root "$ROUTES"
chmod 0644 "$ROUTES"

nginx -t
systemctl reload nginx.service
# Nginx now keeps new database requests away from the embedded Linux engine.
# Restart it before Firebird Server opens the same database files; otherwise
# the first worker request can fail with an incompatible engine-instance lock.
systemctl restart dataexpress-web.service
systemctl restart dataexpress-firebird.service
systemctl restart dataexpress-wine-worker.service
