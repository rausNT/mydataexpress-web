import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const installer = readFileSync('deploy/install.sh', 'utf8');
const readme = readFileSync('README.md', 'utf8');
const runtime = readFileSync('dxtypes.pas', 'utf8');

test('one-line installer pins runtime downloads and runs services unprivileged', () => {
  assert.match(installer, /^set -euo pipefail$/m);
  assert.match(installer, /FB25_SHA256=[a-f0-9]{64}/);
  assert.match(installer, /FB5_SHA256=[a-f0-9]{64}/);
  assert.match(installer, /sha256sum --check/);
  assert.match(installer, /User=dataexpress/);
  assert.match(installer, /ProtectSystem=(?:full|strict)/);
  assert.match(installer, /DX_ADMIN_TOKEN/);
  assert.match(installer, /client_max_body_size 256m/);
  assert.match(installer, /limit_req_zone \$binary_remote_addr/);
  assert.match(installer, /limit_conn dx_connections/);
  assert.match(installer, /bantime = 24h/);
  assert.match(installer, /ufw limit OpenSSH/);
  assert.match(installer, /unattended-upgrades/);
  assert.match(installer, /MaxAuthTries 3/);
  assert.match(installer, /StartLimitIntervalSec=0/);
  assert.match(installer, /ExecStart=\/usr\/bin\/sleep 1/);
});

test('installer keeps persistent state outside an atomic release', () => {
  assert.match(installer, /APP_ROOT=\/opt\/dataexpress/);
  assert.match(installer, /CONFIG_ROOT=\/etc\/dataexpress/);
  assert.match(installer, /STATE_ROOT=\/var\/lib\/dataexpress/);
  assert.match(installer, /ln -sfn "\$RELEASE_DIR" "\$APP_ROOT\/current"/);
  assert.match(installer, /Firebird=5/);
  assert.match(installer, /firebird25/);
  assert.match(installer, /firebird5/);
  assert.match(installer, /BUILD_TOOLCHAIN_PREEXISTED/);
  assert.match(installer, /rm -rf -- "\$BUILD_ROOT"/);
});

test('server selects pinned compatible shared .wepas modules without overriding database modules', () => {
  assert.match(runtime, /AppPath \+ 'extensions'/);
  assert.match(runtime, /FindFirst\(Utf8ToSys\(ExtensionDir \+ '\*\.wepas'\)/);
  assert.match(runtime, /FindScriptByName\(ModuleName\) <> nil then Continue/);
  assert.match(runtime, /AllMappingsAvailable\(Candidate\.ActionIds, AvailableActions\)/);
  assert.match(runtime, /HasMappingOverlap\(Candidate\.FunctionNames, ClaimedFunctions\)/);
  assert.match(runtime, /Script\.Kind := skWebExpr/);
  for (const id of [7867, 7991, 8376, 9551]) {
    assert.match(installer, new RegExp(`forum\\.mydataexpress\\.ru/download/file\\.php\\?id=${id}`));
  }
  assert.match(installer, /DX_PLUS_WEB_181_ARCHIVE_SHA256=[a-f0-9]{64}/);
  assert.match(installer, /DX_PLUS_WEB_181_SOURCE_SHA256=[a-f0-9]{64}/);
  assert.match(installer, /\$STATE_ROOT\/extensions\/DX_PLUS_WEB-\$version\.wepas/);
});

test('README attributes upstream projects and documents the public installer', () => {
  assert.match(readme, /github\.com\/dxbit\/dataexpress/);
  assert.match(readme, /github\.com\/dxbit\/dxwebserver/);
  assert.match(readme, /github\.com\/dxbit\/dataexpress-depend/);
  assert.match(
    readme,
    /raw\.githubusercontent\.com\/rausNT\/mydataexpress-web\/main\/deploy\/install\.sh/,
  );
  assert.match(readme, /\/admin\//);
  assert.match(readme, /(?:HTTPS|TLS)/);
});
