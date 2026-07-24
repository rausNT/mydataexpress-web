# DataExpress Web Server - работайте с базой данных на любом устройстве.

Copyright (c) 2016-2026 Павел Дуборкин

Сайт: https://mydataexpress.ru

## Ветка модернизации

В этой версии добавляются современный адаптивный интерфейс и переносимый слой
совместимости расширений. Документация:

- `MODERNIZATION.md` — изменения веб-интерфейса;
- `docs/extension-compatibility.md` — стратегия миграции расширений;
- `docs/forum-extension-corpus.md` — воспроизводимая проверка реальных модулей форума;
- `docs/provider-api.md` — API кроссплатформенных провайдеров;
- `docs/building-windows.md` — подготовка среды и сборка.

### Миграция расширения

Для исходного desktop-модуля одна команда создаёт web-модуль и manifest.
Самодостаточные routines переносятся прямо в Pascal Script, а Node.js provider
и его конфигурация создаются только для непереносимых операций:

```powershell
npm run migrate:extension -- C:\path\to\OfficeTools.epas
```

Для каталога расширений используйте пакетный режим. Он сохраняет уже имеющиеся
web-модули, генерирует только отсутствующие и создаёт переносимый комплект с
локальным provider SDK:

```powershell
npm run migrate:extensions -- C:\path\to\extensions --output-dir C:\path\to\extensions-web
```

Проверка всего комплекта после реализации handlers:

```powershell
# Структура, mappings и явные отметки реализованных handlers:
npm run verify:extension-bundle -- C:\path\to\extensions-web --offline

# Полная проверка, включая auth, /health и /capabilities всех providers:
npm run verify:extension-bundle -- C:\path\to\extensions-web --config C:\path\to\dxwebsrv.cfg
```

Стабильные `Name` функций и `Id` действий сохраняются. Чистый код со скалярными
типами, зарегистрированными типами runtime и известными portable built-ins
выполняется без HTTP. Безопасные локальные helpers переносятся вместе с
экспортируемой routine. Windows API, OLE, DLL и неизвестные глобальные helpers
направляются через provider. `var`/`out` и сложные типы допустимы для прямого
Pascal Script-переноса, если весь используемый runtime зарегистрирован; через
JSON-provider они не передаются неявно и при невозможной сериализации получают
явный статус `manual`. Флаг `--all-providers` принудительно оставляет все
поддерживаемые routines на серверной provider-границе.

Для распространённой старой функции `HTTP_GET(URL): String` мигратор уже создаёт
готовый кроссплатформенный handler с allow-list хостов, таймаутом, лимитом ответа
и повторной проверкой redirects. Параметры запуска находятся в созданном
`.provider.env.example`.

Полный форумный модуль `SendHttpRequest` версии 1.3 переносится тем же способом:
action сохраняет GUID и переменную `request_result`, а
`SendHttpRequestFunction` — прежний пятиаргументный контракт. GET/POST/PUT/DELETE
выполняются provider-ом с URL allow-list, SSRF-защитой и лимитами request/response;
прямой `THttpClient` из сгенерированного `.wepas` удаляется.

Три OLE-функции форумного модуля DaData также переносятся автоматически.
Провайдер использует HTTPS API DaData, сохраняет совместимый XML-результат и
восстанавливает session variables, от которых зависят существующие
`DA_FIRM_*`, `DA_BANK_FIELD` и `DA_ADDR_FIELD`.

Два действия форумного модуля конвертации Word/Excel теперь тоже переносятся
автоматически. Вместо `Word.Application`/`Excel.Application` создаётся
ограниченный файловыми каталогами LibreOffice handler. Он запускает
`soffice --headless` с отдельным профилем на каждый запрос, сохраняет прежний
Boolean-результат и не требует Microsoft Office или Windows. Установка и
параметры `DX_OFFICE_*` описаны в `docs/provider-api.md`.

Результирующий web-модуль имеет штатное расширение `OfficeTools.wepas`. Проверить
весь каталог desktop/web-модулей перед импортом можно строгим аудитом:

```powershell
node tools/extension-audit.mjs C:\path\to\extensions --config C:\path\to\dxwebsrv.cfg --strict
```

Для воспроизводимого агрегированного отчёта по набору desktop-модулей:

```powershell
npm run report:extension-corpus -- C:\path\to\extensions --output corpus-report.json --strict
```

Перед включением перенесённого расширения проверьте manifest, конфигурацию и
живой provider одной командой:

```powershell
npm run preflight:provider -- C:\path\to\OfficeTools.manifest.json --config C:\path\to\dxwebsrv.cfg
```

### Локальный preview

До сборки Pascal-бэкенда интерфейс можно проверить на локальном preview-сервере:

```powershell
npm run dev
```

После запуска откройте `http://127.0.0.1:8080`. Эндпоинт `/health` возвращает
состояние сервера. Preview использует настоящие шаблоны, стили и JavaScript, но
не имитирует базу данных и честно блокирует вход до появления `dxwebsrv`.

## Установка среды разработки

Для локальной сборки установите 32-битные Lazarus 4.6 и FPC 3.2.2. Именно эта
закреплённая связка используется Windows CI.

Установите компоненты из репозитория https://github.com/dxbit/dataexpress-depend. Вам необходимо установить компоненты PascalScript и bgra. Компоненты 
должны находится в каталоге D:\LazComponents.

Все готово для компиляции исходников!
