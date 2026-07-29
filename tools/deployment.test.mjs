import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const installer = readFileSync('deploy/install.sh', 'utf8');
const workerInstaller = readFileSync('deploy/install-windows-worker.sh', 'utf8');
const readme = readFileSync('README.md', 'utf8');
const runtime = readFileSync('dxtypes.pas', 'utf8');
const htmlRuntime = readFileSync('htmlshow.pas', 'utf8');
const program = readFileSync('dxwebsrv.pas', 'utf8');
const saxReader = readFileSync('saxbasereader.pas', 'utf8');
const appUtils = readFileSync('apputils.pas', 'utf8');
const modernCss = readFileSync('_test/html/modern.css', 'utf8');
const mainJs = readFileSync('_test/html/main.js', 'utf8');
const gitAttributes = readFileSync('.gitattributes', 'utf8');
const mainServer = readFileSync('mainserver.pas', 'utf8');
const sqlGenerator = readFileSync('sqlgen.pas', 'utf8');
const demoDomain = readFileSync('deploy/nginx-domain.conf', 'utf8');

test('one-line installer pins runtime downloads and runs services unprivileged', () => {
  assert.match(gitAttributes, /^\*\.sh text eol=lf$/m);
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
  assert.match(installer,
    /include \/etc\/nginx\/snippets\/dataexpress-worker-routes\.conf;/);
  assert.match(installer,
    /touch \/etc\/nginx\/snippets\/dataexpress-worker-routes\.conf/);
  assert.match(installer, /log_format dataexpress_json escape=json/);
  assert.match(installer, /"ip":"\$remote_addr"/);
  assert.match(installer, /"path":"\$uri"/);
  assert.match(installer, /access_log \/var\/log\/nginx\/dataexpress-access\.log dataexpress_json/);
  assert.match(installer, /\/etc\/logrotate\.d\/dataexpress-nginx/);
  assert.match(installer, /\/var\/lib\/dataexpress\/logs\/dxwebsrv\.log/);
  assert.match(installer, /create 0640 dataexpress dataexpress/);
  assert.match(installer, /rotate 30/);
  assert.match(installer, /maxage 30/);
  assert.match(installer, /chown www-data:adm \/var\/log\/nginx\/dataexpress-access\.log/);
  assert.match(installer, /chmod 0640 \/var\/log\/nginx\/dataexpress-access\.log/);
  assert.doesNotMatch(installer, /dataexpress_json[\s\S]{0,500}\$request_uri/);
  assert.match(installer, /bantime = 24h/);
  assert.match(installer, /ufw limit OpenSSH/);
  assert.match(installer, /unattended-upgrades/);
  assert.match(installer, /\.well-known\/acme-challenge/);
  assert.match(installer, /location ~ \/\\\.\(\?!well-known/);
  assert.match(installer, /ssl_protocols TLSv1\.2 TLSv1\.3/);
  assert.match(installer, /MaxAuthTries 3/);
  assert.match(installer, /StartLimitIntervalSec=0/);
  assert.match(installer, /ExecStart=\/usr\/bin\/sleep 1/);
});

test('installer keeps persistent state outside an atomic release', () => {
  assert.match(installer, /APP_ROOT=\/opt\/dataexpress/);
  assert.match(installer, /CONFIG_ROOT=\/etc\/dataexpress/);
  assert.match(installer, /STATE_ROOT=\/var\/lib\/dataexpress/);
  assert.match(installer, /ln -sfn "\$RELEASE_DIR" "\$APP_ROOT\/current"/);
  assert.match(installer, /install -d -m 0750 -o dataexpress -g dataexpress "\$STATE_ROOT\/logs"/);
  assert.match(installer, /ln -sfn "\$STATE_ROOT\/logs" "\$RELEASE_DIR\/logs"/);
  assert.match(installer, /Firebird=5/);
  assert.match(installer, /firebird25/);
  assert.match(installer, /firebird5/);
  assert.match(installer, /BUILD_TOOLCHAIN_PREEXISTED/);
  assert.match(installer, /rm -rf -- "\$BUILD_ROOT"/);
  assert.match(installer, /restore_services_on_exit/);
  assert.match(installer, /preserving installed copy/);
  assert.ok(
    installer.indexOf('STAGED_EXTENSIONS=') <
      installer.indexOf('systemctl stop dataexpress-config-reload.path'),
  );
});

test('public demo domain discourages crawler indexing', () => {
  assert.match(demoDomain,
    /add_header X-Robots-Tag "noindex, nofollow, noarchive" always/);
  assert.match(demoDomain,
    /location = \/robots\.txt[\s\S]+User-agent: \*\\nDisallow: \//);
});

test('Windows compatibility worker stays loopback-only and uses a pinned artifact', () => {
  assert.match(workerInstaller, /compat-worker-v0\.1\.6/);
  assert.match(workerInstaller,
    /ff66233bf9a29a695220bc5278ad443021ea0b24009e0658bc41935260c34777/);
  assert.match(workerInstaller, /WINEARCH=win64/);
  assert.match(workerInstaller, /CREATE OR ALTER USER SYSDBA PASSWORD 'masterkey'/);
  assert.match(workerInstaller, /select 1 from rdb\$database/);
  assert.match(workerInstaller,
    /WORKER_HANDOFF_STARTED[\s\S]+dataexpress-worker-routes\.backup/);
  assert.match(workerInstaller,
    /INSTALL_SUCCEEDED[\s\S]+systemctl restart dataexpress-web\.service/);
  assert.match(workerInstaller, /rm -f "\$DOS_DEVICES\/z:"/);
  assert.match(workerInstaller,
    /ln -sfn \/var\/lib\/dataexpress "\$DOS_DEVICES\/d:"/);
  assert.match(
    readFileSync('deploy/windows-worker/dataexpress-wine-worker.service', 'utf8'),
    /IPAddressDeny=any[\s\S]+IPAddressAllow=localhost/,
  );
  assert.match(
    readFileSync('deploy/windows-worker/dataexpress-wine-worker.service', 'utf8'),
    /ExecStop=\/usr\/bin\/wineserver -k/,
  );
  assert.match(
    readFileSync('deploy/windows-worker/dataexpress-firebird.service', 'utf8'),
    /IPAddressDeny=any[\s\S]+IPAddressAllow=localhost/,
  );
  assert.match(
    readFileSync('deploy/windows-worker/reconfigure.sh', 'utf8'),
    /RemoteBindAddress = 127\.0\.0\.1/,
  );
  assert.match(
    readFileSync('deploy/windows-worker/reconfigure.sh', 'utf8'),
    /SHARED_EXTENSIONS=\/var\/lib\/dataexpress\/extensions[\s\S]+-iname '\*\.wepas'/,
  );
  assert.match(
    readFileSync('deploy/windows-worker/reconfigure.sh', 'utf8'),
    /reload nginx\.service[\s\S]+restart dataexpress-web\.service[\s\S]+restart dataexpress-firebird\.service/,
  );
});

test('server reports unexpected renderer failures and audits form navigation', () => {
  assert.match(mainServer, /AUDIT form_request/);
  assert.match(mainServer, /SafeIntegerQueryParam\('fm'\)/);
  assert.match(mainServer, /AUDIT navigation_request/);
  assert.match(mainServer, /resource=' \+ ResourceType/);
  assert.match(mainServer, /report_id=/);
  assert.match(mainServer, /response_bytes=/);
  assert.match(mainServer, /outcome=/);
  assert.match(mainServer, /AResponse\.Code := rcServerError/);
  assert.match(mainServer, /LogFormRequestAudit;/);
  assert.match(mainServer, /AUDIT extension_compile_error connection=/);
  assert.match(mainServer, /LogExtensionCompileErrors\(MD\.ScriptMan\)/);
});

test('form filters register object-field joins before resolving their aliases', () => {
  const formFilterStart = sqlGenerator.indexOf('function SqlFormFilter');
  const formFilter = sqlGenerator.slice(
    formFilterStart,
    sqlGenerator.indexOf('function SqlSelectStatement', formFilterStart),
  );
  const objectFieldBranch = formFilter.slice(
    formFilter.indexOf('if C is TdxObjectField then'),
    formFilter.indexOf('else if C is TdxFile then'),
  );
  assert.ok(
    objectFieldBranch.indexOf('ProcessObjectField') <
      objectFieldBranch.indexOf('AliasStr(AliasSL, AliasName)'),
  );
});

test('Linux build selects and registers the headless LCL widgetset', () => {
  const noGuiPath = installer.indexOf('lcl/units/x86_64-linux/nogui');
  const genericPath = installer.indexOf('lcl/units/x86_64-linux"', noGuiPath + 1);
  assert.ok(noGuiPath >= 0 && genericPath > noGuiPath);
  assert.match(program, /clocale,\s*Interfaces,/);
});

test('server selects pinned compatible shared .wepas modules without overriding database modules', () => {
  assert.match(runtime, /AppPath \+ 'extensions'/);
  assert.match(runtime, /FindFirst\(Utf8ToSys\(ExtensionDir \+ '\*\.wepas'\)/);
  assert.match(runtime, /FindScriptByName\(ModuleName\) <> nil then Continue/);
  assert.match(runtime, /AllMappingsAvailable\(Candidate\.ActionIds, AvailableActions\)/);
  assert.match(runtime, /HasMappingOverlap\(Candidate\.FunctionNames, ClaimedFunctions\)/);
  assert.match(runtime, /Disabled incompatible database web extension/);
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

test('HTML responses never emit internal one- or two-digit result codes as HTTP status', () => {
  assert.match(htmlRuntime, /if FResultCode < 100 then Result := rcServerError/);
  assert.match(htmlRuntime, /property ResultCode: Integer read GetResultCode/);
});

test('legacy report XML keeps bare boolean ampersands and Unicode filters', () => {
  assert.match(saxReader, /function NormalizeLegacyXml/);
  assert.match(saxReader, /not HasNamedEntity\(i\) and not HasNumericEntity\(i\)/);
  assert.match(saxReader, /__DATAEXPRESS_OPTIONAL_PARENT__/);
  assert.match(saxReader, /__DATAEXPRESS_PARENT__/);
  assert.match(saxReader, /__DATAEXPRESS_OPTIONAL__/);
  assert.match(saxReader, /__DATAEXPRESS_EXCLAMATION__/);
  assert.match(appUtils, /StringReplace\(S, '__DATAEXPRESS_OPTIONAL_PARENT__', '\?!'/);
  assert.match(saxReader, /inherited ParseStream\(XmlStream\)/);
});

test('modern skin preserves legacy form geometry and readable list selection', () => {
  assert.match(modernCss, /\.main form input\[style\*="position"\][\s\S]*min-height: 0 !important/);
  assert.match(modernCss, /\.listcbx table\.list tr\.sel:hover[\s\S]*color: #fff !important/);
  assert.match(htmlRuntime, /class=database-home href="\/"/);
  for (const template of [
    '_test/html/editform.html',
    '_test/html/form.html',
    '_test/html/loginuser.html',
    '_test/html/report.html',
  ]) {
    assert.match(readFileSync(template, 'utf8'), /modern\.css\?v=\d{8}-\d+/);
  }
});

test('database forms show a session-scoped extension compatibility report', () => {
  assert.match(mainJs, /showExtensionCompatibilityOnFirstOpen/);
  assert.match(mainJs, /fetch\('\?extensioncompat'/);
  assert.match(mainJs, /sessionStorage\.getItem\(storageKey\)/);
  assert.match(mainJs, /dialog\.showModal\(\)/);
  assert.match(mainJs, /extensionCompatibilityWorks/);
  assert.match(mainJs, /item\.blockReason/);
  assert.match(modernCss, /\.extension-compat-dialog::backdrop/);
  assert.match(modernCss,
    /html\[data-theme="dark"\] \.extension-compat-badge\.has-errors/);
});
