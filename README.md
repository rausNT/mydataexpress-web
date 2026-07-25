# DataExpress Web — модернизация

Современная Linux/web-ветка **DataExpress Web Server**: адаптивная стартовая страница,
переносимый слой провайдеров для расширений, инструменты миграции `.epas` → `.wepas`,
безопасная загрузка баз из браузера и воспроизводимое развёртывание на Ubuntu.

Это независимая работа по модернизации, основанная на открытом проекте Павла Дуборкина:

- [DataExpress — настольный конструктор баз](https://github.com/dxbit/dataexpress);
- [DataExpress Web Server — исходный веб-сервер](https://github.com/dxbit/dxwebserver);
- [dataexpress-depend — исходные зависимости](https://github.com/dxbit/dataexpress-depend);
- [сайт DataExpress](https://mydataexpress.ru/), [форум](https://forum.mydataexpress.ru/),
  [официальные демо](https://mydataexpress.ru/demo.html).

Исходные авторские права и лицензия Apache 2.0 сохранены в `LICENSE.txt` и `NOTICE.txt`.

## Установка одной командой

Поддерживается чистая Ubuntu 24.04 x86-64. Команда собирает Pascal-сервер,
устанавливает Firebird runtimes, Nginx и панель импорта, создаёт системные службы и
загружает демонстрационную базу:

```bash
curl -fsSL https://raw.githubusercontent.com/rausNT/mydataexpress-web/main/deploy/install.sh | sudo bash
```

Для критичной инфраструктуры сначала скачайте `deploy/install.sh`, прочитайте его и
запустите локальный файл. Установщик выводит адрес сервера и случайный ключ
администратора. Повторный запуск создаёт новый release, сохраняя конфигурацию и базы.

После установки:

- `/` — список подключённых баз;
- `/admin/` — загрузка `.DXDB`, `.FDB`, ZIP-комплекта с базой и каталогом
  `templates`, а также добавление шаблонов к уже подключённой базе;
- `/health` — проверка процесса DataExpress.

Пока домен и TLS не настроены, не загружайте через публичный HTTP базы с личными или
коммерческими данными. Админ-ключ защищает от несанкционированной загрузки, но не
шифрует сетевой трафик.

## Что модернизировано

- Linux x86-64 сборка без графического интерфейса Lazarus;
- Nginx как единая публичная точка входа, backend-процессы доступны только локально;
- запуск от непривилегированного пользователя `dataexpress` и systemd hardening;
- UFW, усиленный SSH/fail2ban, автоматические security updates и ограничения
  частоты HTTP-запросов и соединений;
- browser uploader с bearer-аутентификацией, лимитами размера, защитой ZIP path
  traversal/symlink, атомарной регистрацией подключения и безопасной установкой
  DOCX/DOCM/XML/ODT/ODS/HTML-шаблонов;
- определение Firebird ODS 11/12/13 и автоматическая миграция старых баз через
  backup/restore в Firebird 5 ODS 13;
- общесерверный каталог переносимых `.wepas`: модуль из самой базы имеет приоритет,
  а отсутствующий стандартный web-модуль подхватывается без изменения `.DXDB`;
- проверенные по хешу официальные web-версии `DX_PLUS 1.71`–`1.8.1` с
  автоматическим выбором совместимой пары по GUID действий и именам функций из
  [темы форума DataExpress](https://forum.mydataexpress.ru/viewtopic.php?f=16&t=3295);
- адаптивная стартовая страница и безопасное отображение подключений;
- анализ, пакетная миграция и проверка `.epas/.wepas`;
- portable providers для HTTP, DaData и преобразования Word/Excel через LibreOffice.

## Совместимость расширений

Мигратор сохраняет имена функций и GUID действий. Переносимый Pascal Script остаётся
в `.wepas`; Windows API, COM/OLE, DLL и другие платформенные вызовы направляются в
изолированный provider-контракт. Реестр capabilities автоматически узнаёт уже
поддержанные семейства и применяется также к новым `.epas/.wepas`.

Важно: произвольный новый Windows-only код нельзя корректно «угадать» и выполнить на
Linux только по синтаксису. Поэтому неизвестная capability автоматически
обнаруживается, получает manifest/provider scaffold и явно отмечается как
`capability-unresolved`, пока для её семантики не добавлен handler. Это исключает
ложное обещание совместимости и тихие ошибки данных.

Одна база или модуль:

```powershell
npm run migrate:extension -- C:\path\to\Extension.epas
```

Каталог модулей:

```powershell
npm run migrate:extensions -- C:\path\to\extensions --output-dir C:\path\to\extensions-web
npm run verify:extension-bundle -- C:\path\to\extensions-web --offline
```

Документация:

- [стратегия совместимости](docs/extension-compatibility.md);
- [корпус расширений форума](docs/forum-extension-corpus.md);
- [provider API](docs/provider-api.md);
- [стартовая страница](docs/landing-page.md);
- [защита production-сервера](docs/server-security.md);
- [сборка Windows](docs/building-windows.md).

## Разработка и тесты

Для JS-инструментов нужен Node.js 20+:

```bash
npm test
npm run dev
```

`npm run dev` открывает preview на `http://127.0.0.1:8080`. Полная CI дополнительно
собирает Win32 Pascal-сервер, компилирует сгенерированные `.wepas` и проверяет реальные
LibreOffice providers. Linux installer собирает backend напрямую FPC 3.2.2 с
Lazarus nogui units.
