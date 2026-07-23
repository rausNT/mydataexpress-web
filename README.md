# DataExpress Web Server - работайте с базой данных на любом устройстве.

Copyright (c) 2016-2026 Павел Дуборкин

Сайт: https://mydataexpress.ru

## Ветка модернизации

В этой версии добавляются современный адаптивный интерфейс и переносимый слой
совместимости расширений. Документация:

- `MODERNIZATION.md` — изменения веб-интерфейса;
- `docs/extension-compatibility.md` — стратегия миграции расширений;
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
типами и известными portable built-ins выполняется без HTTP. Windows API, OLE,
DLL и неизвестные глобальные helpers направляются через provider. `var`/`out`
и сложные типы остаются явно помеченными для ручной реализации — без скрытого
пропуска операции в рабочей системе. Флаг `--all-providers` принудительно
оставляет все поддерживаемые routines на серверной provider-границе.

Результирующий web-модуль имеет штатное расширение `OfficeTools.wepas`. Проверить
весь каталог desktop/web-модулей перед импортом можно строгим аудитом:

```powershell
node tools/extension-audit.mjs C:\path\to\extensions --config C:\path\to\dxwebsrv.cfg --strict
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

Вам необходимо установить среду разработки Lazarus версии 4.6 и компилятор Free Pascal из ветки fixes-3.2 (3.2.3) с помощью fpcupdeluxe. Устанавливайте 32-битные версии.

Установите компоненты из репозитория https://github.com/dxbit/dataexpress-depend. Вам необходимо установить компоненты PascalScript и bgra. Компоненты 
должны находится в каталоге D:\LazComponents.

Все готово для компиляции исходников!
