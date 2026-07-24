import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const installer = readFileSync('deploy/install.sh', 'utf8');
const readme = readFileSync('README.md', 'utf8');

test('one-line installer pins runtime downloads and runs services unprivileged', () => {
  assert.match(installer, /^set -euo pipefail$/m);
  assert.match(installer, /FB25_SHA256=[a-f0-9]{64}/);
  assert.match(installer, /FB5_SHA256=[a-f0-9]{64}/);
  assert.match(installer, /sha256sum --check/);
  assert.match(installer, /User=dataexpress/);
  assert.match(installer, /ProtectSystem=(?:full|strict)/);
  assert.match(installer, /DX_ADMIN_TOKEN/);
  assert.match(installer, /client_max_body_size 256m/);
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
