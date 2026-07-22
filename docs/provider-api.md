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

## Генерация provider из manifest

Основной инструмент миграции создаёт provider scaffold автоматически. Для
отдельного запуска:

```powershell
npm run scaffold:provider -- OfficeTools.manifest.json
```

В сгенерированном `.provider.mjs` перечислены только операции со статусом
`provider`, сигнатуры параметров оставлены комментариями, а каждый handler
содержит явный `TODO`. После реализации задайте токен и запустите файл:

```powershell
$env:DX_PROVIDER_TOKEN = 'replace-with-a-long-random-token'
node OfficeTools.provider.mjs
```

Пример запуска:

```powershell
$env:DX_PROVIDER_TOKEN = 'replace-with-a-long-random-token'
node examples/providers/portable-provider.mjs
```
