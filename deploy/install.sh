#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="${DX_REPOSITORY:-https://github.com/rausNT/mydataexpress-web.git}"
REF="${DX_REF:-main}"
APP_ROOT=/opt/dataexpress
BUILD_ROOT=/opt/dataexpress-build
CONFIG_ROOT=/etc/dataexpress
STATE_ROOT=/var/lib/dataexpress
RUNTIME_ROOT="$APP_ROOT/runtime"
ADMIN_ROOT="$APP_ROOT/admin"
RELEASE_ID="$(date -u +%Y%m%d%H%M%S)"
RELEASE_DIR="$APP_ROOT/releases/$RELEASE_ID"
SERVICES_STOPPED=0

restore_services_on_exit() {
  local status=$?
  if [ "$status" -ne 0 ] && [ "$SERVICES_STOPPED" -eq 1 ]; then
    systemctl start dataexpress-web.service dataexpress-admin.service \
      dataexpress-config-reload.path nginx.service >/dev/null 2>&1 || true
  fi
}
trap restore_services_on_exit EXIT

FB25_URL=https://github.com/FirebirdSQL/firebird/releases/download/R2_5_9/FirebirdCS-2.5.9.27139-0.amd64.tar.gz
FB25_SHA256=59b1f64db56f50c94ee47babd1bf551cacebd0bdf7f668d6250d18a621390b4e
FB5_URL=https://github.com/FirebirdSQL/firebird/releases/download/v5.0.4/Firebird-5.0.4.1812-0-linux-x64.tar.gz
FB5_SHA256=ab6a15a0258f38b022be496bb5e038c14e8628ce9acd0f9a06288a3baedd917b
NCURSES5_URL=https://archive.ubuntu.com/ubuntu/pool/universe/n/ncurses/libncurses5_6.3-2ubuntu0.2_amd64.deb
NCURSES5_SHA256=91d18fcc4165a40d27e8181eb282bcaf89c2a5e6c6dc182b37df33827407361c
TINFO5_URL=https://archive.ubuntu.com/ubuntu/pool/universe/n/ncurses/libtinfo5_6.3-2ubuntu0.2_amd64.deb
TINFO5_SHA256=b9bb64e716a7d9de05b1b33992763142ca81bcae3a7f8ce7e29fa3c6fd32f1e8
DX_PLUS_WEB_171_URL=https://forum.mydataexpress.ru/download/file.php?id=7867
DX_PLUS_WEB_171_ARCHIVE_SHA256=9a4a023b6beace941dfd9fd450b2f8e97f953c6a05f30b1e9b67c04e833a254b
DX_PLUS_WEB_171_SOURCE_SHA256=cd6e773185b9663f15a47bf11019ce91d027fcdf9b105ea07f61535e16009811
DX_PLUS_WEB_172_URL=https://forum.mydataexpress.ru/download/file.php?id=7991
DX_PLUS_WEB_172_ARCHIVE_SHA256=93e228f0ef71a753d4f743a85cc40ac71ec38169bdea8e027e831837cba86879
DX_PLUS_WEB_172_SOURCE_SHA256=b2da1a2f5de6859eb6d3d91b0ab6696fba5232d02770a017e2d047d4b49d7dbf
DX_PLUS_WEB_173_URL=https://forum.mydataexpress.ru/download/file.php?id=8376
DX_PLUS_WEB_173_ARCHIVE_SHA256=065a4c0a688163eaeac403fbcafbc499fb65d6f8b30d7e29c8b950c62039c003
DX_PLUS_WEB_173_SOURCE_SHA256=ec8424f82ff918cd51bd87c2efc8150b6fb8f3a9c721d39a1f18977d94077442
DX_PLUS_WEB_181_URL=https://forum.mydataexpress.ru/download/file.php?id=9551
DX_PLUS_WEB_181_ARCHIVE_SHA256=61e6b8c9ba30f937e6dec0911759de4b9d881617c9737c01385b51af004b549f
DX_PLUS_WEB_181_SOURCE_SHA256=70004f5705946548b736116874a3e0714b85508ff257e94a63edb4b91d412c23

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: curl ... | sudo bash" >&2
  exit 1
fi
if [ "$(dpkg --print-architecture)" != amd64 ]; then
  echo "The current installer supports Ubuntu/Debian amd64 only." >&2
  exit 1
fi

BUILD_TOOLCHAIN_PREEXISTED=0
if command -v fpc >/dev/null 2>&1 ||
   dpkg-query -W -f='${Status}' lazarus-src 2>/dev/null | grep -q 'install ok installed'; then
  BUILD_TOOLCHAIN_PREEXISTED=1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl fail2ban git nginx openssl python3 ufw unattended-upgrades unzip \
  firebird3.0-server-core firebird3.0-utils libfbclient2 \
  fp-compiler fp-units-base fp-units-db fp-units-fcl fp-units-misc fp-units-net \
  lazarus-src lcl-nogui lcl-units

if ! id dataexpress >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_ROOT" --shell /usr/sbin/nologin dataexpress
fi

rm -rf "$BUILD_ROOT"
install -d -m 0755 "$BUILD_ROOT" "$APP_ROOT/releases" "$RUNTIME_ROOT"
git clone --depth 1 --branch "$REF" "$REPOSITORY" "$BUILD_ROOT/source"
git clone --depth 1 https://github.com/dxbit/dataexpress-depend.git "$BUILD_ROOT/dependencies/dataexpress-depend"

LAZARUS_DIR="$(find /usr/lib/lazarus -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)"
if [ -z "$LAZARUS_DIR" ]; then
  echo "Lazarus units were not found." >&2
  exit 1
fi

SOURCE="$BUILD_ROOT/source"
DEPENDENCIES="$BUILD_ROOT/dependencies/dataexpress-depend"
install -d "$SOURCE/_linux-bin" "$SOURCE/lib/x86_64-linux"
(
  cd "$SOURCE"
  fpc -B -MObjFPC -Scghi -CX -O1 -g -gl -vewnhibq \
    -dUseCThreads -dBGRABITMAP_DONT_USE_LCL \
    -Fu. \
    -Fu"$LAZARUS_DIR/lcl/units/x86_64-linux/nogui" \
    -Fu"$LAZARUS_DIR/lcl/units/x86_64-linux" \
    -Fu"$LAZARUS_DIR/components/lazutils" \
    -Fu"$LAZARUS_DIR/components/freetype" \
    -Fu"$DEPENDENCIES/PascalScript/Source" \
    -Fu"$DEPENDENCIES/bgra/bgrabitmap" \
    -Fi. -FE_linux-bin -FUlib/x86_64-linux dxwebsrv.pas
)

download_checked() {
  local url="$1"
  local checksum="$2"
  local output="$3"
  curl --fail --location --retry 3 --output "$output" "$url"
  echo "$checksum  $output" | sha256sum --check -
}

STAGED_RUNTIME="$BUILD_ROOT/runtime-stage"
install -d \
  "$BUILD_ROOT/runtime-downloads/firebird25" \
  "$BUILD_ROOT/runtime-downloads/firebird5" \
  "$STAGED_RUNTIME/compat"

download_checked "$FB25_URL" "$FB25_SHA256" "$BUILD_ROOT/runtime-downloads/firebird25.tar.gz"
tar -xzf "$BUILD_ROOT/runtime-downloads/firebird25.tar.gz" -C "$BUILD_ROOT/runtime-downloads/firebird25"
tar -xzf "$BUILD_ROOT/runtime-downloads/firebird25"/FirebirdCS-*/buildroot.tar.gz \
  -C "$BUILD_ROOT/runtime-downloads/firebird25"
cp -a "$BUILD_ROOT/runtime-downloads/firebird25/opt/firebird" "$STAGED_RUNTIME/firebird25"

download_checked "$FB5_URL" "$FB5_SHA256" "$BUILD_ROOT/runtime-downloads/firebird5.tar.gz"
tar -xzf "$BUILD_ROOT/runtime-downloads/firebird5.tar.gz" -C "$BUILD_ROOT/runtime-downloads/firebird5"
tar -xzf "$BUILD_ROOT/runtime-downloads/firebird5"/Firebird-*/buildroot.tar.gz \
  -C "$BUILD_ROOT/runtime-downloads/firebird5"
cp -a "$BUILD_ROOT/runtime-downloads/firebird5/opt/firebird" "$STAGED_RUNTIME/firebird5"

download_checked "$NCURSES5_URL" "$NCURSES5_SHA256" "$BUILD_ROOT/runtime-downloads/libncurses5.deb"
download_checked "$TINFO5_URL" "$TINFO5_SHA256" "$BUILD_ROOT/runtime-downloads/libtinfo5.deb"
install -d "$BUILD_ROOT/runtime-downloads/ncurses"
dpkg-deb -x "$BUILD_ROOT/runtime-downloads/libncurses5.deb" "$BUILD_ROOT/runtime-downloads/ncurses"
dpkg-deb -x "$BUILD_ROOT/runtime-downloads/libtinfo5.deb" "$BUILD_ROOT/runtime-downloads/ncurses"

STAGED_EXTENSIONS="$BUILD_ROOT/extensions-stage"
install -d "$STAGED_EXTENSIONS"
install_dx_plus_web() {
  local version="$1"
  local url="$2"
  local archive_checksum="$3"
  local source_checksum="$4"
  local archive="$BUILD_ROOT/runtime-downloads/dx-plus-web-$version.zip"
  local source="$BUILD_ROOT/DX_PLUS_WEB-$version.wepas"
  local destination="$STAGED_EXTENSIONS/DX_PLUS_WEB-$version.wepas"
  local existing="$STATE_ROOT/extensions/DX_PLUS_WEB-$version.wepas"
  if download_checked "$url" "$archive_checksum" "$archive" &&
     unzip -p "$archive" DX_PLUS_WEB.wepas >"$source" &&
     echo "$source_checksum  $source" | sha256sum --check -; then
    install -m 0644 "$source" "$destination"
  elif [ -s "$existing" ]; then
    echo "Warning: could not refresh DX_PLUS_WEB $version; preserving installed copy." >&2
    cp -a "$existing" "$destination"
  else
    echo "Warning: DX_PLUS_WEB $version is currently unavailable; continuing without it." >&2
  fi
}
install_dx_plus_web 1.71 "$DX_PLUS_WEB_171_URL" \
  "$DX_PLUS_WEB_171_ARCHIVE_SHA256" "$DX_PLUS_WEB_171_SOURCE_SHA256"
install_dx_plus_web 1.72 "$DX_PLUS_WEB_172_URL" \
  "$DX_PLUS_WEB_172_ARCHIVE_SHA256" "$DX_PLUS_WEB_172_SOURCE_SHA256"
install_dx_plus_web 1.73 "$DX_PLUS_WEB_173_URL" \
  "$DX_PLUS_WEB_173_ARCHIVE_SHA256" "$DX_PLUS_WEB_173_SOURCE_SHA256"
install_dx_plus_web 1.8.1 "$DX_PLUS_WEB_181_URL" \
  "$DX_PLUS_WEB_181_ARCHIVE_SHA256" "$DX_PLUS_WEB_181_SOURCE_SHA256"

systemctl stop dataexpress-config-reload.path dataexpress-admin.service dataexpress-web.service \
  >/dev/null 2>&1 || true
SERVICES_STOPPED=1
cp -a "$BUILD_ROOT/runtime-downloads/ncurses/lib/x86_64-linux-gnu"/libncurses.so.5* "$STAGED_RUNTIME/compat/"
cp -a "$BUILD_ROOT/runtime-downloads/ncurses/lib/x86_64-linux-gnu"/libtinfo.so.5* "$STAGED_RUNTIME/compat/"
rm -rf "$RUNTIME_ROOT/firebird25" "$RUNTIME_ROOT/firebird5" "$RUNTIME_ROOT/compat"
cp -a "$STAGED_RUNTIME/." "$RUNTIME_ROOT/"

chown root:root "$RUNTIME_ROOT/firebird25" "$RUNTIME_ROOT/firebird5" "$RUNTIME_ROOT/compat"
chown dataexpress:dataexpress "$RUNTIME_ROOT/firebird25/security2.fdb" "$RUNTIME_ROOT/firebird5/security5.fdb"
chmod 0600 "$RUNTIME_ROOT/firebird25/security2.fdb" "$RUNTIME_ROOT/firebird5/security5.fdb"

install -d -m 0750 -o dataexpress -g dataexpress "$RELEASE_DIR"
install -m 0755 -o dataexpress -g dataexpress "$SOURCE/_linux-bin/dxwebsrv" "$RELEASE_DIR/dxwebsrv"
strip "$RELEASE_DIR/dxwebsrv"
for asset in html img languages templates favicon.ico Except.dic LICENSE.txt NOTICE.txt libPadeg.so; do
  if [ -e "$SOURCE/_test/$asset" ]; then
    cp -a "$SOURCE/_test/$asset" "$RELEASE_DIR/"
  fi
done
install -d -m 0750 -o dataexpress -g dataexpress "$RELEASE_DIR/cache" "$RELEASE_DIR/logs" "$RELEASE_DIR/fb5"
ln -s "$RUNTIME_ROOT/firebird5/lib/libfbclient.so.5.0.4" "$RELEASE_DIR/fb5/libfbclient.so"
chown -R dataexpress:dataexpress "$RELEASE_DIR"

install -d -m 0770 -o root -g dataexpress "$CONFIG_ROOT"
install -d -m 0755 -o root -g root "$STATE_ROOT"
install -d -m 0750 -o dataexpress -g dataexpress "$STATE_ROOT/databases"
install -d -m 0755 -o root -g dataexpress "$STATE_ROOT/extensions"
install -m 0660 -o dataexpress -g dataexpress /dev/null "$STATE_ROOT/config.lock"
find "$STATE_ROOT/extensions" -maxdepth 1 -type f -name 'DX_PLUS_WEB-*.wepas' -delete
if compgen -G "$STAGED_EXTENSIONS/DX_PLUS_WEB-*.wepas" >/dev/null; then
  install -m 0644 -o root -g dataexpress \
    "$STAGED_EXTENSIONS"/DX_PLUS_WEB-*.wepas "$STATE_ROOT/extensions/"
fi
ln -sfn "$STATE_ROOT/extensions" "$RELEASE_DIR/extensions"
chown -h dataexpress:dataexpress "$RELEASE_DIR/extensions"

CONFIG="$CONFIG_ROOT/dxwebsrv.cfg"
if [ ! -f "$CONFIG" ]; then
  cat >"$CONFIG" <<'CFG'
[Server]
Language=ru
Address=127.0.0.1
Port=8080
UseSSL=False
Firebird=5
DebugMode=False
ShowConnections=1
CFG
else
  sed -i \
    -e 's/^Address=.*/Address=127.0.0.1/' \
    -e 's/^Port=.*/Port=8080/' \
    -e 's/^Firebird=.*/Firebird=5/' \
    -e 's/^DebugMode=.*/DebugMode=False/' \
    -e 's/^ShowConnections=.*/ShowConnections=1/' \
    "$CONFIG"
fi
chown root:dataexpress "$CONFIG"
chmod 0660 "$CONFIG"
ln -sfn "$RELEASE_DIR" "$APP_ROOT/current"
ln -sfn "$CONFIG" "$RELEASE_DIR/dxwebsrv.cfg"
chown -h dataexpress:dataexpress "$RELEASE_DIR/dxwebsrv.cfg"

install -d -m 0755 -o root -g root "$ADMIN_ROOT"
install -m 0755 -o root -g root "$SOURCE/deploy/admin/dataexpress_admin.py" "$ADMIN_ROOT/dataexpress_admin.py"
install -m 0644 -o root -g root "$SOURCE/deploy/admin/index.html" "$ADMIN_ROOT/index.html"
if [ ! -f "$CONFIG_ROOT/admin.env" ]; then
  umask 0027
  printf 'DX_ADMIN_TOKEN=%s\n' "$(openssl rand -hex 24)" >"$CONFIG_ROOT/admin.env"
fi
chown root:dataexpress "$CONFIG_ROOT/admin.env"
chmod 0640 "$CONFIG_ROOT/admin.env"

install -d -m 0755 /etc/systemd/journald.conf.d
cat >/etc/systemd/journald.conf.d/dataexpress-retention.conf <<'JOURNAL'
[Journal]
SystemMaxUse=256M
RuntimeMaxUse=128M
MaxRetentionSec=14day
Compress=yes
JOURNAL

cat >/etc/systemd/system/dataexpress-web.service <<'UNIT'
[Unit]
Description=DataExpress Web Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dataexpress
Group=dataexpress
WorkingDirectory=/opt/dataexpress/current
Environment=FIREBIRD=/opt/dataexpress/runtime/firebird5
Environment=LD_LIBRARY_PATH=/opt/dataexpress/runtime/firebird5/lib
ExecStart=/opt/dataexpress/current/dxwebsrv -r
Restart=on-failure
RestartSec=3
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=/opt/dataexpress /var/lib/dataexpress
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
UNIT

cat >/etc/systemd/system/dataexpress-admin.service <<'UNIT'
[Unit]
Description=DataExpress database import service
After=network.target

[Service]
Type=simple
User=dataexpress
Group=dataexpress
EnvironmentFile=/etc/dataexpress/admin.env
Environment=DX_CONFIG=/etc/dataexpress/dxwebsrv.cfg
Environment=DX_DATABASE_ROOT=/var/lib/dataexpress/databases
Environment=DX_ADMIN_HTML=/opt/dataexpress/admin/index.html
ExecStart=/usr/bin/python3 /opt/dataexpress/admin/dataexpress_admin.py
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/etc/dataexpress /var/lib/dataexpress /opt/dataexpress/runtime/firebird25 /opt/dataexpress/runtime/firebird5

[Install]
WantedBy=multi-user.target
UNIT

cat >/etc/systemd/system/dataexpress-config-reload.service <<'UNIT'
[Unit]
Description=Reload DataExpress after configuration change
StartLimitIntervalSec=0

[Service]
Type=oneshot
ExecStart=/usr/bin/sleep 1
ExecStart=/usr/bin/systemctl try-restart dataexpress-web.service
UNIT

cat >/etc/systemd/system/dataexpress-config-reload.path <<'UNIT'
[Unit]
Description=Watch DataExpress configuration

[Path]
PathChanged=/etc/dataexpress/dxwebsrv.cfg
Unit=dataexpress-config-reload.service

[Install]
WantedBy=multi-user.target
UNIT

cat >/etc/nginx/conf.d/dataexpress-security.conf <<'NGINX'
server_tokens off;
limit_req_status 429;
limit_conn_status 429;
limit_req_zone $binary_remote_addr zone=dx_requests:10m rate=20r/s;
limit_conn_zone $binary_remote_addr zone=dx_connections:10m;
map $args $dx_login_key {
    default "";
    ~^login(?:&|$) $binary_remote_addr;
}
limit_req_zone $dx_login_key zone=dx_logins:10m rate=10r/m;
NGINX

install -d -m 0755 /var/www/letsencrypt/.well-known/acme-challenge
cat >/etc/nginx/sites-available/dataexpress <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    client_max_body_size 256m;
    client_header_timeout 15s;
    client_body_timeout 60s;
    keepalive_timeout 20s;
    send_timeout 60s;
    reset_timedout_connection on;
    limit_conn dx_connections 30;
    limit_req zone=dx_requests burst=80 nodelay;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "same-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type text/plain;
        try_files $uri =404;
    }
    location = /admin { return 301 /admin/; }
    location /admin/ {
        limit_conn dx_connections 3;
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_request_buffering off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
    location / {
        limit_req zone=dx_requests burst=80 nodelay;
        limit_req zone=dx_logins burst=10 nodelay;
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
NGINX
SERVER_IP="$(hostname -I | awk '{print $1}')"
if [ -f "/etc/letsencrypt/live/$SERVER_IP/fullchain.pem" ] &&
   [ -f "/etc/letsencrypt/live/$SERVER_IP/privkey.pem" ]; then
  cat >>/etc/nginx/sites-available/dataexpress <<NGINX
server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name $SERVER_IP;
    ssl_certificate /etc/letsencrypt/live/$SERVER_IP/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$SERVER_IP/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:DXTLS:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;
    client_max_body_size 256m;
    client_header_timeout 15s;
    client_body_timeout 60s;
    keepalive_timeout 20s;
    send_timeout 60s;
    reset_timedout_connection on;
    limit_conn dx_connections 30;
    limit_req zone=dx_requests burst=80 nodelay;
    add_header Strict-Transport-Security "max-age=15552000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "same-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

    location = /admin { return 301 /admin/; }
    location /admin/ {
        limit_conn dx_connections 3;
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_request_buffering off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto https;
    }
    location / {
        limit_req zone=dx_requests burst=80 nodelay;
        limit_req zone=dx_logins burst=10 nodelay;
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
NGINX
fi
rm -f /etc/nginx/sites-enabled/default
ln -sfn /etc/nginx/sites-available/dataexpress /etc/nginx/sites-enabled/dataexpress
nginx -t

cat >/etc/fail2ban/jail.d/dataexpress.local <<'JAIL'
[sshd]
enabled = true
backend = systemd
mode = aggressive
maxretry = 4
findtime = 10m
bantime = 24h
bantime.increment = true
bantime.factor = 2
bantime.maxtime = 1w
JAIL

install -d -m 0755 /etc/ssh/sshd_config.d
cat >/etc/ssh/sshd_config.d/90-dataexpress-hardening.conf <<'SSHD'
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
AllowTcpForwarding no
PermitTunnel no
GatewayPorts no
ClientAliveInterval 300
ClientAliveCountMax 2
MaxStartups 10:30:30
SSHD
sshd -t

printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' \
  >/etc/apt/apt.conf.d/20auto-upgrades

systemctl daemon-reload
systemctl restart systemd-journald.service
systemctl enable --now \
  dataexpress-web.service dataexpress-admin.service dataexpress-config-reload.path \
  fail2ban.service nginx.service unattended-upgrades.service
SERVICES_STOPPED=0
systemctl reload ssh.service
systemctl reset-failed dataexpress-config-reload.service
systemctl restart dataexpress-web.service dataexpress-admin.service nginx.service

for attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 3 http://127.0.0.1/health >/dev/null &&
     curl --fail --silent --max-time 3 http://127.0.0.1/admin/api/health >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent http://127.0.0.1/health >/dev/null
curl --fail --silent http://127.0.0.1/admin/api/health >/dev/null

if ! awk '
  /^\[/ {
    section=tolower($0)
    if (section != "[server]" && section !~ /^\[provider:/) found=1
  }
  END { exit found ? 0 : 1 }
' "$CONFIG"; then
  source "$CONFIG_ROOT/admin.env"
  DEMO_ARCHIVE="$BUILD_ROOT/DEMO_DB.DXDB.zip"
  curl --fail --location --retry 3 \
    --output "$DEMO_ARCHIVE" \
    https://mydataexpress.ru/files/demodb/DEMO_DB.DXDB.zip
  curl --fail --silent --show-error \
    --header "Authorization: Bearer $DX_ADMIN_TOKEN" \
    --header "X-Database-Alias: DemoDB" \
    --header "X-Filename: DEMO_DB.DXDB.zip" \
    --header "Content-Type: application/octet-stream" \
    --data-binary "@$DEMO_ARCHIVE" \
    http://127.0.0.1/admin/api/databases >/dev/null
  systemctl restart dataexpress-web.service
fi

ufw --force delete allow OpenSSH >/dev/null 2>&1 || true
ufw limit OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw default deny incoming
ufw default allow outgoing
ufw --force enable

test "$BUILD_ROOT" = /opt/dataexpress-build
rm -rf -- "$BUILD_ROOT"
if [ "$BUILD_TOOLCHAIN_PREEXISTED" -eq 0 ]; then
  mapfile -t INSTALLED_BUILD_PACKAGES < <(
    apt list --installed 2>/dev/null |
      cut -d/ -f1 |
      grep -E '^(fp-|fpc|lazarus|lcl-)' ||
      true
  )
  if [ "${#INSTALLED_BUILD_PACKAGES[@]}" -gt 0 ]; then
    apt-get purge -y "${INSTALLED_BUILD_PACKAGES[@]}"
  fi
  apt-get clean
fi

SERVER_ADDRESS="$(hostname -I | awk '{print $1}')"
source "$CONFIG_ROOT/admin.env"
echo
echo "DataExpress is ready: http://$SERVER_ADDRESS/"
echo "Database administration: http://$SERVER_ADDRESS/admin/"
echo "Admin token: stored in $CONFIG_ROOT/admin.env"
echo "Read it with: sudo sed -n 's/^DX_ADMIN_TOKEN=//p' $CONFIG_ROOT/admin.env"
echo "Enable HTTPS before uploading private production databases."
