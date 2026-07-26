#!/usr/bin/env bash
set -euo pipefail

WORKER_VERSION="${DX_WORKER_VERSION:-compat-worker-v0.1.5}"
WORKER_URL="${DX_WORKER_URL:-https://github.com/rausNT/mydataexpress-web/releases/download/$WORKER_VERSION/dxwebsrv-wine-worker.zip}"
WORKER_SHA256="${DX_WORKER_SHA256:-6693f97edbf0ff040f1e6fd71684993d3285a9a2dd886c460c668636ba330e44}"
WORKER_ROOT=/opt/dataexpress-wine
STATE_ROOT=/var/lib/dataexpress-wine
PREFIX="$STATE_ROOT/prefix"
APP_DIR="$PREFIX/drive_c/dataexpress"
RELEASE_DIR="$WORKER_ROOT/releases/$WORKER_VERSION"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: curl ... | sudo bash" >&2
  exit 1
fi
if [ "$(dpkg --print-architecture)" != amd64 ]; then
  echo "The Wine worker installer supports Ubuntu/Debian amd64 only." >&2
  exit 1
fi
if [ ! -x /opt/dataexpress/current/dxwebsrv ] ||
   [ ! -f /etc/dataexpress/dxwebsrv.cfg ]; then
  echo "Install the main DataExpress web service first." >&2
  exit 1
fi
if ! grep -q 'dataexpress-worker-routes.conf' /etc/nginx/sites-available/dataexpress; then
  echo "Update the main DataExpress installation before enabling the worker." >&2
  exit 1
fi
if ! [[ "$WORKER_SHA256" =~ ^[[:xdigit:]]{64}$ ]]; then
  echo "DX_WORKER_SHA256 must be a 64-character SHA-256 digest." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
if ! dpkg --print-foreign-architectures | grep -qx i386; then
  dpkg --add-architecture i386
fi
install -d -m 0755 /etc/apt/keyrings
curl --fail --location --retry 3 \
  --output /etc/apt/keyrings/winehq-archive.key \
  https://dl.winehq.org/wine-builds/winehq.key
curl --fail --location --retry 3 \
  --output /etc/apt/sources.list.d/winehq-noble.sources \
  https://dl.winehq.org/wine-builds/ubuntu/dists/noble/winehq-noble.sources
apt-get update
apt-get install -y --install-recommends winehq-stable xvfb
apt-get install -y --no-install-recommends systemd-zram-generator

if ! swapon --show=NAME --noheadings | grep -q .; then
  cat >/etc/systemd/zram-generator.conf <<'EOF'
[zram0]
zram-size = ram / 2
compression-algorithm = zstd
EOF
  if modprobe zram 2>/dev/null; then
    systemctl daemon-reload
    systemctl start /dev/zram0
  else
    install -d -m 0750 "$STATE_ROOT"
    truncate -s 0 "$STATE_ROOT/swapfile"
    fallocate -l 256M "$STATE_ROOT/swapfile"
    chmod 0600 "$STATE_ROOT/swapfile"
    mkswap "$STATE_ROOT/swapfile"
    swapon "$STATE_ROOT/swapfile"
    if ! grep -qF "$STATE_ROOT/swapfile none swap sw 0 0" /etc/fstab; then
      printf '%s\n' "$STATE_ROOT/swapfile none swap sw 0 0" >>/etc/fstab
    fi
  fi
fi

if ! id dataexpress >/dev/null 2>&1; then
  echo "The main DataExpress service user is missing." >&2
  exit 1
fi

DOWNLOAD_ROOT="$(mktemp -d)"
MAIN_SERVICE_STOPPED=0
WORKER_HANDOFF_STARTED=0
INSTALL_SUCCEEDED=0
ROUTES_BACKUP="$DOWNLOAD_ROOT/dataexpress-worker-routes.backup"

cleanup() {
  exit_status=$?
  set +e
  if [ "$WORKER_HANDOFF_STARTED" -eq 1 ] &&
     [ "$INSTALL_SUCCEEDED" -eq 0 ]; then
    systemctl stop dataexpress-wine-worker.service \
      dataexpress-firebird.service
    if [ -f "$ROUTES_BACKUP" ]; then
      cp "$ROUTES_BACKUP" /etc/nginx/snippets/dataexpress-worker-routes.conf
      chown root:root /etc/nginx/snippets/dataexpress-worker-routes.conf
      chmod 0644 /etc/nginx/snippets/dataexpress-worker-routes.conf
      nginx -t && systemctl reload nginx.service
    fi
    systemctl restart dataexpress-web.service
  elif [ "$MAIN_SERVICE_STOPPED" -eq 1 ]; then
    systemctl start dataexpress-web.service
  fi
  rm -rf "$DOWNLOAD_ROOT"
  return "$exit_status"
}
trap cleanup EXIT

curl --fail --location --retry 3 --output "$DOWNLOAD_ROOT/worker.zip" "$WORKER_URL"
echo "$WORKER_SHA256  $DOWNLOAD_ROOT/worker.zip" | sha256sum --check -
python3 - "$DOWNLOAD_ROOT/worker.zip" "$DOWNLOAD_ROOT/package" <<'PY'
import shutil
import sys
from pathlib import Path, PurePosixPath
from zipfile import ZipFile

archive = Path(sys.argv[1])
destination = Path(sys.argv[2])
destination.mkdir(parents=True, exist_ok=True)

with ZipFile(archive) as zip_file:
    for entry in zip_file.infolist():
        normalized = entry.filename.replace("\\", "/")
        relative = PurePosixPath(normalized)
        if relative.is_absolute() or ".." in relative.parts:
            raise SystemExit(f"Unsafe path in worker archive: {entry.filename!r}")
        target = destination.joinpath(*relative.parts)
        if entry.is_dir() or normalized.endswith("/"):
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        with zip_file.open(entry) as source, target.open("wb") as output:
            shutil.copyfileobj(source, output)
PY

install -d -m 0755 "$WORKER_ROOT/releases" "$WORKER_ROOT/bin"
install -d -m 0750 -o dataexpress -g dataexpress "$STATE_ROOT"
install -d -m 0750 -o dataexpress -g dataexpress "$RELEASE_DIR"
cp -a "$DOWNLOAD_ROOT/package/." "$RELEASE_DIR/"
chown -R root:root "$RELEASE_DIR"

install -m 0755 "$RELEASE_DIR/worker-tools/configure.py" \
  "$WORKER_ROOT/bin/configure.py"
install -m 0755 "$RELEASE_DIR/worker-tools/reconfigure.sh" \
  "$WORKER_ROOT/bin/reconfigure.sh"

install -d -m 0750 -o dataexpress -g dataexpress "$PREFIX"
install -d -m 0750 -o dataexpress -g dataexpress "$STATE_ROOT/cache"
runuser -u dataexpress -- env WINEPREFIX="$PREFIX" WINEARCH=win64 WINEDEBUG=-all \
  HOME="$STATE_ROOT" XDG_CACHE_HOME="$STATE_ROOT/cache" \
  WINEDLLOVERRIDES='mscoree,mshtml=' \
  xvfb-run -a wineboot -u

install -d -m 0750 -o dataexpress -g dataexpress "$APP_DIR"
cp -a "$RELEASE_DIR/." "$APP_DIR/"
chown -R dataexpress:dataexpress "$APP_DIR"

DOS_DEVICES="$PREFIX/dosdevices"
install -d -m 0750 -o dataexpress -g dataexpress "$DOS_DEVICES"
rm -f "$DOS_DEVICES/z:"
ln -sfn /var/lib/dataexpress "$DOS_DEVICES/d:"
chown -h dataexpress:dataexpress "$DOS_DEVICES/d:"

install -m 0644 "$RELEASE_DIR/worker-tools/dataexpress-firebird.service" \
  /etc/systemd/system/dataexpress-firebird.service
install -m 0644 "$RELEASE_DIR/worker-tools/dataexpress-wine-worker.service" \
  /etc/systemd/system/dataexpress-wine-worker.service
install -m 0644 "$RELEASE_DIR/worker-tools/dataexpress-wine-config.service" \
  /etc/systemd/system/dataexpress-wine-config.service
install -m 0644 "$RELEASE_DIR/worker-tools/dataexpress-wine-config.path" \
  /etc/systemd/system/dataexpress-wine-config.path

systemctl daemon-reload
BOOTSTRAP_DIR="$STATE_ROOT/bootstrap"
install -d -m 0750 -o dataexpress -g dataexpress "$BOOTSTRAP_DIR"
install -m 0640 -o dataexpress -g dataexpress \
  /opt/dataexpress/runtime/firebird5/examples/empbuild/employee.fdb \
  "$BOOTSTRAP_DIR/employee.fdb"
systemctl stop dataexpress-wine-worker.service \
  dataexpress-firebird.service 2>/dev/null || true
systemctl stop dataexpress-web.service
MAIN_SERVICE_STOPPED=1
printf "%s\n" \
  "CREATE OR ALTER USER SYSDBA PASSWORD 'masterkey';" \
  "COMMIT;" |
  runuser -u dataexpress -- env \
    FIREBIRD=/opt/dataexpress/runtime/firebird5 \
    LD_LIBRARY_PATH=/opt/dataexpress/runtime/firebird5/lib \
    /opt/dataexpress/runtime/firebird5/bin/isql -q -user sysdba \
    "$BOOTSTRAP_DIR/employee.fdb"
systemctl start dataexpress-web.service
MAIN_SERVICE_STOPPED=0
systemctl enable dataexpress-firebird.service dataexpress-wine-worker.service \
  dataexpress-wine-config.path
cp /etc/nginx/snippets/dataexpress-worker-routes.conf "$ROUTES_BACKUP"
WORKER_HANDOFF_STARTED=1
"$WORKER_ROOT/bin/reconfigure.sh"
systemctl start dataexpress-wine-config.path

FIRST_DATABASE="$(
  awk -F= '
    /^[[:space:]]*Database[[:space:]]*=/ {
      value=$0
      sub(/^[^=]*=/, "", value)
      print value
      exit
    }
  ' /etc/dataexpress/dxwebsrv.cfg
)"
if [ -z "$FIRST_DATABASE" ]; then
  echo "The main DataExpress config has no database to validate." >&2
  exit 1
fi
printf '%s\n' 'select 1 from rdb$database;' |
  env FIREBIRD=/opt/dataexpress/runtime/firebird5 \
    LD_LIBRARY_PATH=/opt/dataexpress/runtime/firebird5/lib \
    /opt/dataexpress/runtime/firebird5/bin/isql -q \
    -user sysdba -password masterkey "127.0.0.1:$FIRST_DATABASE" \
    >/dev/null

for _ in $(seq 1 60); do
  if curl --fail --silent http://127.0.0.1:8180/health |
     grep -q '"status":"ok"'; then
    INSTALL_SUCCEEDED=1
    echo "DataExpress Wine worker is ready on loopback port 8180."
    echo "Database routes remain available at their original public URLs."
    exit 0
  fi
  sleep 1
done

echo "The Wine worker did not become healthy." >&2
systemctl --no-pager --full status dataexpress-firebird.service \
  dataexpress-wine-worker.service >&2 || true
exit 1
