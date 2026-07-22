# Сборка на Windows

Проект требует 32-битные Lazarus 4.6 и Free Pascal из ветки fixes-3.2
(версия 3.2.3).

1. Создать `D:\LazarusDX` и `D:\LazComponents`.
2. Скачать `fpcupdeluxe-i386-win32.exe` из официального релиза fpcupdeluxe.
3. В fpcupdeluxe задать путь `D:\LazarusDX`, FPC `fixes-3.2`, Lazarus `4.6` и
   установить обе части среды. Сообщение о том, что `svn` не найден, является
   информационным: официальный fpcupdeluxe загружает bootstrap-инструменты сам.
4. Клонировать `https://github.com/dxbit/dataexpress-depend` в
   `D:\LazComponents`.
5. Выполнить скрипт сборки. Он найдёт fpcupdeluxe-установку, зарегистрирует
   `pascalscript.lpk`, `PascalScriptFCL.lpk` и `bgrabitmappack4nogui.lpk`, затем
   соберёт `dxwebsrv.lpi` в режиме `Win32`:

```powershell
powershell -ExecutionPolicy Bypass -File tools\build-windows.ps1
```

Если среда установлена в другое место, передайте пути явно:

```powershell
powershell -ExecutionPolicy Bypass -File tools\build-windows.ps1 `
  -LazarusRoot C:\LazarusDX\lazarus `
  -ComponentsRoot C:\LazComponents
```

До появления этих инструментов JavaScript и миграционные утилиты проверяются
отдельно, но сборка серверного бинарника не считается подтверждённой.

GitHub Actions дополнительно запускает сквозные проверки на Windows: генерирует
`.wepas` из тестового `.epas` и компилирует его штатным `TScriptCompiler`, после
чего проверяет реальный вызов Pascal → HTTP → Node provider. Зелёный job означает,
что проверены и бинарник сервера, и совместимость результата мигратора с
PascalScript, а не только синтаксис JavaScript.
