# Extension Provider API

Провайдер заменяет платформозависимую реализацию расширения переносимым HTTP
сервисом. Pascal Script вызывает:

```pascal
Result := ExtensionProviderCall('OfficeTools', 'ConvertDocument', PayloadJson);
```

## Настройка Web Server

В `dxwebsrv.cfg` добавляется отдельная секция. Она не считается подключением к
базе данных благодаря префиксу `Provider:`.

```ini
[Provider:OfficeTools]
Url=http://127.0.0.1:9081/
Token=replace-with-a-long-random-token
TimeoutMs=30000
# Только для доверенной изолированной сети; по умолчанию False:
AllowInsecure=False
```

Сервер отправляет `POST` без редиректов:

```json
{
  "operation": "ConvertDocument",
  "payload": {
    "FileName": "invoice.docx"
  }
}
```

Заголовок авторизации: `Authorization: Bearer <Token>`. Успешный ответ:

```json
{"ok": true, "result": "result.pdf"}
```

Логин, пароль и API-ключи нельзя помещать в `Url`: используйте `Token` и HTTPS.
Диагностические отчёты удаляют userinfo, query и fragment из отображаемого URL.

`payload` сохраняет JSON-типы скалярных параметров: строки остаются строками,
Boolean — `true`/`false`, числа передаются JSON-числами, `null` — как `null`.
Провайдер также должен возвращать результат с соответствующим JSON-типом.
Сгенерированный web-модуль использует следующие встроенные адаптеры:

- `ExtensionProviderCall` — строки;
- `ExtensionProviderCallBoolean` — Boolean;
- `ExtensionProviderCallInt64` — целые числа;
- `ExtensionProviderCallFloat` — вещественные числа и Currency;
- `ExtensionProviderCallDateTime` — ISO 8601 или числовая дата DataExpress;
- `ExtensionProviderCallVariant` — примитивный Variant, а объекты/массивы как JSON-строка.

Такой контракт не зависит от регионального десятичного разделителя Windows:
вещественные числа на проводе всегда используют JSON-разделитель `.`.

Ошибка:

```json
{"ok": false, "error": "Unsupported document format"}
```

Ответ ограничен 16 МБ, таймаут конфигурации ограничивается диапазоном от 1 до
300 секунд. Для локального companion-agent рекомендуется слушать только
`127.0.0.1`. Удалённый провайдер должен использовать HTTPS; обычный HTTP вне
localhost блокируется, если явно не задано `AllowInsecure=True`.

## Тестовый runtime

`tools/provider-sdk.mjs` реализует контракт на стандартном Node.js без внешних
зависимостей. Он проверяет Bearer-токен, размер тела, имя операции и всегда
возвращает стабильную JSON-обёртку.

При передаче `manifest` в `createProviderServer` runtime до открытия порта
проверяет schema version, дубликаты операций и наличие всех обязательных
handlers. Поэтому неполная миграция завершается понятной ошибкой при запуске, а
не при первом действии пользователя. Операции со статусом `manual` публикуются
как ограничения, но handler для них не требуется.

С тем же Bearer-токеном доступны:

- `GET /health` — готовность, имя провайдера и полнота миграции;
- `GET /capabilities` — обязательные операции, ручные ограничения и лишние handlers.

Без корректного `Authorization: Bearer <Token>` оба адреса возвращают `401`.

Диагностика DataExpress `?extensioncompat` извлекает литеральные имена provider
из web-модулей и сверяет их с секциями `dxwebsrv.cfg`. Отсутствующая секция или
пустой `Url` дают статус `provider-unconfigured`, а динамически вычисляемое имя —
`provider-unresolved`; оба состояния оставляют общую совместимость неполной.
Проверяется именно наличие конфигурации. Сетевая готовность самого процесса
provider контролируется его защищённым `GET /health`.

## Генерация provider из manifest

Основной инструмент миграции создаёт provider scaffold автоматически. Для
отдельного запуска:

```powershell
npm run scaffold:provider -- OfficeTools.manifest.json
```

Рядом с provider создаётся `dataexpress-provider-sdk.mjs`, а импорт в scaffold
указывает на эту локальную копию. Для переноса на другой сервер копируйте
`.provider.mjs`, `.manifest.json`, `.provider.env.example` и
`dataexpress-provider-sdk.mjs` вместе. Файл окружения содержит порт, токен и
дополнительную политику готовых provider-рецептов.

Каждый сгенерированный handler имеет отметку
`dataExpressImplemented = false`. После реализации операции измените её на
`true`. Пока хотя бы одна отметка остаётся `false`, provider завершает запуск с
ошибкой и не может ошибочно объявить незавершённый scaffold готовым через
`/capabilities`.

В сгенерированном `.provider.mjs` перечислены только операции со статусом
`provider`, сигнатуры параметров оставлены комментариями. Неизвестная операция
получает явный `TODO`; распознанный встроенный рецепт сразу получает
`dataExpressImplemented = true`.

Операции manifest со статусом `web-script` уже выполняются внутри `.wepas` и не
требуют handler или provider-секции. Если manifest состоит только из таких
операций, `preflight:provider` завершает структурную проверку без сетевого вызова.

```powershell
$env:DX_PROVIDER_TOKEN = 'replace-with-a-long-random-token'
node OfficeTools.provider.mjs
```

Или скопируйте `.provider.env.example` в `.provider.env`, замените значения и
используйте штатную загрузку окружения Node.js:

```powershell
node --env-file=OfficeTools.provider.env OfficeTools.provider.mjs
```

## Автоматический рецепт HTTP_GET

Старое расширение форума `HTTP_GET(URL: Variant): String` использует OLE для
кодирования URL, но сам запрос выполняет через `THttpClient`. Для этой строго
ограниченной сигнатуры мигратор создаёт `providerRecipe.kind = "http-get"` и
готовый handler вместо `TODO`. Остальные функции с похожим именем или другой
сигнатурой автоматически не подменяются.

Handler использует встроенный стабильный `fetch` Node.js и
`AbortSignal.timeout`; внешние зависимости не нужны. Документация runtime:
[Node.js global fetch и AbortSignal](https://nodejs.org/docs/latest/api/globals.html#fetch).

Перед запуском настройте созданный `.provider.env`:

```dotenv
DX_PROVIDER_TOKEN=replace-with-the-same-long-random-token-as-dxwebsrv.cfg
DX_PROVIDER_HOST=127.0.0.1
DX_PROVIDER_PORT=9081
DX_HTTP_ALLOW_HOSTS=api.example.com,*.trusted.example
DX_HTTP_ALLOW_PRIVATE=false
DX_HTTP_ALLOW_INSECURE=false
DX_HTTP_TIMEOUT_MS=15000
DX_HTTP_MAX_RESPONSE_BYTES=2097152
DX_HTTP_MAX_REDIRECTS=3
```

Без `DX_HTTP_ALLOW_HOSTS` процесс не запускается. `*` разрешает любой публичный
хост, но предпочтителен короткий явный список. По умолчанию запрещены:

- протоколы кроме HTTPS;
- логин или пароль внутри URL;
- loopback, link-local, private, multicast и документационные IP-диапазоны;
- ответ больше 2 МБ;
- более трёх redirects.

Каждый redirect заново проходит проверку протокола, hostname и адреса.
`DX_HTTP_ALLOW_PRIVATE=true` и `DX_HTTP_ALLOW_INSECURE=true` нужны только для
явно доверенной локальной интеграции. Таймаут ограничен 120 секундами, размер
ответа — 32 МБ, число redirects — десятью независимо от значений окружения.

## Автоматический рецепт DaData

Для проверенного форумного модуля мигратор распознаёт три точные сигнатуры:
`DA_FIRM_GET`, `DA_BANK_GET` и `DA_ADDR_GET`. Каждая получает
`providerRecipe.kind = "dadata-suggest"` и готовый handler для `party`, `bank`
или `address`. Используется официальный endpoint
`https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/` с JSON,
`Authorization: Token …` и `count=1`.

Старый модуль возвращал XML и одновременно записывал реквизиты в переменные
выражений. Новый handler сохраняет обе части контракта:

- JSON-ответ преобразуется в совместимый `<SuggestResponse>…</SuggestResponse>`;
- реквизиты разворачиваются в state bundle с именами `data.inn`,
  `data.address.value` и т. п.;
- generated `.wepas` применяет bundle через `Session.SetExprVar`;
- поля, которых нет в новом ответе, получают `Null`, поэтому старые значения
  не остаются в сессии;
- прежние переводы статуса, типа организации, типа филиала и дат сохраняются.

Рекомендуется убрать API-ключ из пользовательских выражений и задать его в
окружении provider. Для обратной совместимости параметр `ApiKey` по-прежнему
принимается, если `DX_DADATA_API_KEY` пуст:

```dotenv
DX_DADATA_API_KEY=replace-with-dadata-api-key
DX_DADATA_BASE_URL=https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/
DX_DADATA_ALLOW_PRIVATE=false
DX_DADATA_ALLOW_INSECURE=false
DX_DADATA_TIMEOUT_MS=15000
DX_DADATA_MAX_RESPONSE_BYTES=2097152
```

`DX_DADATA_BASE_URL` обычно менять не нужно. Разрешения private/plain HTTP
предназначены только для локального тестового proxy; production endpoint должен
оставаться HTTPS. Официальное описание формата запросов:
[DaData — подсказки по организациям](https://dadata.ru/api/suggest/party/).

## Автоматический рецепт Word/Excel

Форумный модуль конвертации содержит два action с routines `convert_Word` и
`convert_Excel`. Мигратор проверяет не только имя: требуются исходные три
строковых параметра, Boolean-результат и характерные OLE/SaveAs-вызовы. После
совпадения manifest получает `providerRecipe.kind =
"office-document-convert"`, а scaffold — готовый
`createOfficeDocumentHandler`. Стабильные GUID действий остаются прежними.

Handler использует LibreOffice CLI, а не Microsoft Office COM:

```text
soffice --headless --convert-to <extension>:<filter> --outdir <temporary> <input>
```

На Windows LibreOffice можно установить через актуальный пакет `winget`:

```powershell
winget install --id TheDocumentFoundation.LibreOffice --exact `
  --accept-package-agreements --accept-source-agreements
& 'C:\Program Files\LibreOffice\program\soffice.exe' --version
```

Если `winget` недоступен, используйте
[официальную загрузку LibreOffice](https://www.libreoffice.org/download/download-libreoffice/).
На Debian/Ubuntu:

```bash
sudo apt update
sudo apt install libreoffice
soffice --version
```

Скопируйте `.provider.env.example` в `.provider.env` и задайте каталоги,
которыми разрешено пользоваться provider:

```dotenv
DX_OFFICE_BINARY=C:\Program Files\LibreOffice\program\soffice.exe
DX_OFFICE_BINARY_ARGS=[]
DX_OFFICE_INPUT_ROOTS=C:\DataExpress\files
DX_OFFICE_OUTPUT_ROOTS=C:\DataExpress\files
DX_OFFICE_TIMEOUT_MS=120000
DX_OFFICE_MAX_INPUT_BYTES=67108864
DX_OFFICE_MAX_OUTPUT_BYTES=134217728
DX_OFFICE_MAX_CONCURRENCY=2
```

Корневые каталоги должны существовать до запуска. На Windows несколько
каталогов разделяются `;`, на Linux — `:`. Относительный путь вычисляется от
рабочего каталога provider. Перед чтением и перед записью проверяется
канонический путь, поэтому `..` и символьные ссылки не могут вывести операцию за
разрешённый root. Новые вложенные выходные каталоги создаются только после этой
проверки. Provider проверяет существование roots и выполняет
`soffice --version` до открытия порта; поэтому зелёный `/health` не скрывает
отсутствующую зависимость.

Каждый запрос получает отдельный временный каталог и отдельный LibreOffice
profile через `-env:UserInstallation=file:...`. Вход ограничен 64 МБ, результат
— 128 МБ, таймаут — 120 секунд; значения можно уменьшить или увеличить в
указанных пределах. Одновременно выполняются не более двух конвертаций
(`DX_OFFICE_MAX_CONCURRENCY`, допустимо 1–16). Успешный handler возвращает
`true`, как исходные action.
Существующий выходной файл перезаписывается только внутри разрешённого каталога.

Автоматически сопоставлены распространённые Writer-форматы DOC/DOCX/DOCM,
DOT/DOTX/DOTM, ODT, PDF, RTF, HTML и TXT, а также Calc-форматы XLS/XLSX/XLSM,
XLTX/XLTM, ODS, PDF, CSV, TXT, HTML и XML. XPS, MHT, XLSB и редкие устаревшие
WK/WJ-форматы не имеют равноценного переносимого LibreOffice export filter и
завершаются явной ошибкой вместо создания файла с неверным содержимым. Макросы
не исполняются; их сохранение при переходе между macro-enabled форматами зависит
от фильтра LibreOffice.

Поддерживаемый синтаксис `--convert-to` и имена фильтров описаны в официальной
документации:
[параметры запуска LibreOffice](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html) и
[таблица conversion filters](https://help.libreoffice.org/latest/en-US/text/shared/guide/convertfilters.html).

После установки можно проверить Writer и Calc на реальных шаблонах
дистрибутива:

```powershell
npm run smoke:office-provider
```

Тот же smoke автоматически выполняется в Linux CI с настоящим LibreOffice и
проверяет, что оба результата начинаются с сигнатуры `%PDF-`.

Пример запуска:

```powershell
$env:DX_PROVIDER_TOKEN = 'replace-with-a-long-random-token'
node examples/providers/portable-provider.mjs
```

## Проверка перед развёртыванием

После запуска provider проверьте всю цепочку manifest → `dxwebsrv.cfg` → HTTP:

```powershell
npm run preflight:provider -- C:\path\to\OfficeTools.manifest.json --config C:\path\to\dxwebsrv.cfg
```

Команда проверяет формат manifest и конфигурации, политику HTTPS, Bearer-токен,
`GET /health`, `GET /capabilities` и наличие всех обязательных операций. Она
возвращает ненулевой код при ошибке и никогда не выводит токен. Незавершённые
ручные адаптации блокируют проверку; для осознанного временного исключения есть
параметр `--allow-manual`.

Для пакетного комплекта те же проверки запускаются сразу по всем manifest:

```powershell
npm run verify:extension-bundle -- C:\extensions-web --config C:\server\dxwebsrv.cfg
```

Если `.wepas` ссылается на provider без manifest, live-проверка завершается
ошибкой: без списка обязательных операций нельзя доказать совместимость.
