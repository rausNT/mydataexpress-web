import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const settings = readFileSync(new URL('../appsettings.pas', import.meta.url), 'utf8');
const serverView = readFileSync(new URL('../htmlshow.pas', import.meta.url), 'utf8');
const template = readFileSync(new URL('../_test/html/index.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../_test/html/index.css', import.meta.url), 'utf8');
const script = readFileSync(new URL('../_test/html/index.js', import.meta.url), 'utf8');
const demoTerms = readFileSync(new URL('../_test/html/demo-terms.html', import.meta.url), 'utf8');
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
  assert.match(settings, /Item\.DemoCredentials := ReadString\(Sect, 'DemoCredentials', ''\)/);
  assert.match(serverView, /if AppSet\.ShowConnections then/);
  assert.match(serverView, /Value\[j\] in \['a'\.\.'z', 'A'\.\.'Z', '0'\.\.'9', '_'\]/);
  assert.match(serverView, /ConnectionUrl := '\/' \+ LowerCase\(ConnectionAlias\) \+ '\/'/);
  assert.match(serverView, /StrToHtml\(ConnectionName\)/);
  assert.match(serverView, /StrToHtml\(ConnectionDescription\)/);
  assert.match(serverView, /StrToHtml\(ConnectionCredentials\)/);
  assert.match(serverView, /class="connection-details"/);
  assert.match(
    serverView,
    /StringReplace\(Result, '\[landing-title\]', StrToHtml\(rsLandingTitle\), \[rfReplaceAll\]\)/,
  );
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
  assert.match(template, /class="upload-database" href="\/admin\/" target="_self"/);
  assert.match(template, /class="demo-disclaimer"/);
  assert.match(template, /href="\/html\/demo-terms\.html" target="_self"/);
  assert.match(template, /index\.css\?v=20260725-4/);
  assert.match(demoTerms, /index\.css\?v=20260725-4/);
  assert.match(template, /\[open-existing-connection\]/);
  assert.match(styles, /@media \(max-width: 640px\)/);
  assert.match(styles, /\.demo-disclaimer/);
  assert.match(styles, /\.connection-grid/);
  assert.match(styles, /\.connection-credentials/);
  assert.match(styles, /:focus-visible/);
});

test('demo terms clearly prohibit real data and preserve mandatory liability', () => {
  assert.match(demoTerms, /только\s+вымышленные\s+или\s+надлежащим\s+образом\s+обезличенные\s+данные/i);
  assert.match(demoTerms, /персональные данные реальных людей/i);
  assert.match(demoTerms, /не исключает ответственность[\s\S]+запрещено законом/i);
  assert.match(demoTerms, /ответственность\s+за\s+умышленное\s+нарушение/i);
  assert.match(demoTerms, /Обязательные права потребителей/i);
  assert.match(demoTerms, /террористическая\s+и\s+экстремистская\s+деятельность/i);
  assert.match(demoTerms, /Это не мессенджер и не хранилище/i);
  assert.match(demoTerms, /не предназначен[\s\S]+как мессенджер/i);
  assert.match(demoTerms, /обмена сообщениями[\s\S]+между пользователями/i);
  assert.match(demoTerms, /уполномоченным государственным органам[\s\S]+законного\s+основания/i);
  assert.match(demoTerms, /IP-адрес пользователя/i);
  assert.match(demoTerms, /путь без строки параметров/i);
  assert.match(demoTerms, /обычный срок хранения — до 30 суток/i);
  assert.match(demoTerms, /не записыва(?:ет|ют)[\s\S]+тела POST-запросов/i);
  assert.match(demoTerms, /идентификаторы формы, записи и вложенной таблицы/i);
  assert.match(demoTerms, /не записывают содержимое полей и записей базы/i);
  assert.match(demoTerms, /href="\/" target="_self"/);
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
    'Загрузить новую базу',
    'Или открыть существующее подключение',
    'Имя существующего подключения',
    'Доступные подключения',
  ]) {
    assert.match(russian, new RegExp(`msgstr "${translation}"`));
  }
});
