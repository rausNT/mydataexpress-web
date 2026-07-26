#!/usr/bin/env bash
set -euo pipefail

WORKER_VERSION="${DX_WORKER_VERSION:-compat-worker-v0.1.2}"
WORKER_URL="${DX_WORKER_URL:-https://github.com/rausNT/mydataexpress-web/releases/download/$WORKER_VERSION/dxwebsrv-wine-worker.zip}"
WORKER_SHA256="${DX_WORKER_SHA256:-8e7dececdedc291b2551c0864efaac6372770e603e97b81e9dc2ebcb606d9e8f}"
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
trap 'rm -rf "$DOWNLOAD_ROOT"' EXIT
curl --fail --location --retry 3 --output "$DOWNLOAD_ROOT/worker.zip" "$WORKER_URL"
echo "$WORKER_SHA256  $DOWNLOAD_ROOT/worker.zip" | sha256sum --check -
unzip -q "$DOWNLOAD_ROOT/worker.zip" -d "$DOWNLOAD_ROOT/package"

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
runuser -u dataexpress -- env WINEPREFIX="$PREFIX" WINEARCH=win64 WINEDEBUG=-all \
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
systemctl enable dataexpress-firebird.service dataexpress-wine-worker.service \
  dataexpress-wine-config.path
"$WORKER_ROOT/bin/reconfigure.sh"
systemctl start dataexpress-wine-config.path

for _ in $(seq 1 60); do
  if curl --fail --silent http://127.0.0.1:8180/health |
     grep -q '"status":"ok"'; then
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
