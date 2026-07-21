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

Пример запуска:

```powershell
$env:DX_PROVIDER_TOKEN = 'replace-with-a-long-random-token'
node examples/providers/portable-provider.mjs
```
