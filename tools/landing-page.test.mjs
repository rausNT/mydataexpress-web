import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const settings = readFileSync(new URL('../appsettings.pas', import.meta.url), 'utf8');
const serverView = readFileSync(new URL('../htmlshow.pas', import.meta.url), 'utf8');
const template = readFileSync(new URL('../_test/html/index.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../_test/html/index.css', import.meta.url), 'utf8');
const script = readFileSync(new URL('../_test/html/index.js', import.meta.url), 'utf8');
const russian = readFileSync(new URL('../_test/languages/dxwebsrv.ru.po', import.meta.url), 'utf8');

test('Pascal resource-string identifiers stay unique', () => {
  const identifiers = [...readFileSync(new URL('../strconsts.pas', import.meta.url), 'utf8')
    .matchAll(/^\s*(rs[A-Za-z0-9_]+)\s*=/gm)]
    .map((match) => match[1].toLowerCase());
  assert.equal(new Set(identifiers).size, identifiers.length);
});

test('connection discovery is explicit and does not expose database paths by default', () => {
  assert.match(settings, /FShowConnections := ReadBool\('Server', 'ShowConnections', False\)/);
  assert.match(settings, /property ShowConnections: Boolean read FShowConnections/);
  assert.match(serverView, /if AppSet\.ShowConnections then/);
  assert.match(serverView, /Value\[j\] in \['a'\.\.'z', 'A'\.\.'Z', '0'\.\.'9', '_'\]/);
  assert.match(serverView, /ConnectionUrl := '\/' \+ LowerCase\(ConnectionName\) \+ '\/'/);
  assert.match(serverView, /StrToHtml\(ConnectionName\)/);
  assert.doesNotMatch(
    serverView.slice(
      serverView.indexOf('function THtmlShow.ShowIndexPage'),
      serverView.indexOf('function THtmlShow.FieldChange'),
    ),
    /DatabasePath|DBPwd|ServiceId/,
  );
});

test('landing template is keyboard-friendly and responsive', () => {
  assert.match(template, /<main class="landing-shell">/);
  assert.match(template, /<html lang="\[lng\]">/);
  assert.match(template, /<label for="connection-name">/);
  assert.match(template, /pattern="\[A-Za-z0-9_\]\+"/);
  assert.match(template, /role="alert" aria-live="polite"/);
  assert.match(template, /src="\/html\/index\.js" defer/);
  assert.match(styles, /@media \(max-width: 640px\)/);
  assert.match(styles, /\.connection-grid/);
  assert.match(styles, /:focus-visible/);
});

test('connection form builds only routable DataExpress aliases', () => {
  const getConnectionPath = new Function(
    'window',
    'document',
    `${script}\nreturn connectionPath;`,
  )({ addEventListener() {} }, {});
  assert.equal(getConnectionPath(' DemoDB '), '/demodb/');
  assert.equal(getConnectionPath('sales_2026'), '/sales_2026/');
  assert.equal(getConnectionPath('../admin'), '');
  assert.equal(getConnectionPath('база'), '');
  assert.equal(getConnectionPath('name with spaces'), '');
});

test('new landing strings have Russian translations', () => {
  for (const translation of [
    'Сервер готов',
    'Открыть базу данных',
    'Имя подключения',
    'Доступные подключения',
  ]) {
    assert.match(russian, new RegExp(`msgstr "${translation}"`));
  }
});
