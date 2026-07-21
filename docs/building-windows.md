# Сборка на Windows

Проект требует 32-битные Lazarus 4.5 и Free Pascal 3.2.3.

1. Создать `D:\LazarusDX` и `D:\LazComponents`.
2. Скачать `fpcupdeluxe-i386-win32.exe` из официального релиза fpcupdeluxe.
3. В fpcupdeluxe задать путь `D:\LazarusDX`, FPC `3.2.3`, Lazarus `4.5` и
   установить обе части среды.
4. Клонировать `https://github.com/dxbit/dataexpress-depend` в
   `D:\LazComponents`.
5. Установить в Lazarus пакеты PascalScript и BGRA.
6. Собрать `dxwebsrv.lpi` в режиме `Win32`:

```powershell
lazbuild --build-mode=Win32 dxwebsrv.lpi
```

До появления этих инструментов JavaScript и миграционные утилиты проверяются
отдельно, но сборка серверного бинарника не считается подтверждённой.
