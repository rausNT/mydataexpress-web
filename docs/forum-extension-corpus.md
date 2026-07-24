# Проверка расширений из официального форума

Срез от 23 июля 2026 года проверяет мигратор на опубликованных пользователями
расширениях, а не только на синтетических fixtures репозитория. Исходники
расширений в этот репозиторий не копируются: они принадлежат их авторам.
Воспроизводимый отчёт содержит только имена файлов, статусы mappings, причины и
агрегаты.

## Воспроизведение

1. Скачайте нужные архивы из
   [каталога расширений](https://forum.mydataexpress.ru/exts.php).
2. Распакуйте desktop-модули `.epas` в один каталог с любым уровнем вложенности.
3. Постройте отчёт:

```powershell
npm run report:extension-corpus -- C:\extensions --output corpus-report.json --strict
```

`--strict` отклоняет пустой корпус и любое сопоставление со статусом `manual`.
Сетевой код переносится с отметкой `reviewRequired`; если до ручной проверки
политики URL, таймаутов и секретов его тоже нужно считать блокирующим, используйте
`--strict-review`.

Отчёт детерминирован по составу модулей и mappings; меняется только поле
`generatedAt`. В него намеренно не попадает текст routines, токены или
конфигурация серверов.

## Контрольная выборка

| Расширение | Тема | Attachment | SHA-256 скачанного архива |
|---|---:|---:|---|
| Математика | [5372](https://forum.mydataexpress.ru/viewtopic.php?t=5372) | 9351 | `85241F4779F38D3BBB3A0B267A96E142C30CCA9EBD55ABABD44F9D89B1D8F504` |
| Encode/Decode URL | [5313](https://forum.mydataexpress.ru/viewtopic.php?t=5313) | 9180 | `E09D349F10CAE50673E29EC943528960A94FAB9EE923EE41FF26C25E56E3E587` |
| Office Word/Excel convert | [5343](https://forum.mydataexpress.ru/viewtopic.php?t=5343) | 9548 | `468D8792E2A97BA974892FCBB8ACCC4A67B507BB5988D153C02E8B4064F8D596` |
| Клик по кнопке + web | [4835](https://forum.mydataexpress.ru/viewtopic.php?t=4835) | 9872 | `A98FD889CBBA36FDA35952DB2C9A90B0C2BE4D78504FCDB7D7B44DEC95DDA046` |
| HTTP-запрос + web | [5323](https://forum.mydataexpress.ru/viewtopic.php?t=5323) | 9272 | `BA119F60879814F28193C0A8BCC7DC89455CBA9792367EDEA9C1916645FB881E` |
| DaData | [1497](https://forum.mydataexpress.ru/viewtopic.php?t=1497) | 2365 | `ED201E309CFC47F85C28E09F32C178554EA71956A515924533DDB180ACEF4AEB` |
| HTTP GET | каталог расширений | 8115 | `EEE415F4530A92B2BBF7D368A7C0344DB1AC3B7B83E8FAC319F96CEB6A5344F4` |

Дополнительно проверялся готовый web-модуль RecordEditor (attachment 8708,
SHA-256 `BAD18825F23454A6C1BAB690DD0A9E2A8C5F0A5BF756E8B4F96172F7D4FF5011`)
как пример штатного `.wepas`, но он не входит в статистику desktop-миграции.

## Результат

```json
{
  "modules": 7,
  "mappings": 61,
  "webScript": 55,
  "provider": 6,
  "automatedProvider": 1,
  "manual": 0,
  "reviewRequired": 2,
  "complete": true
}
```

Чистые вычисления, известные типы runtime, локальные helpers и существующие
web-паттерны переносятся напрямую. Шесть операций с OLE/Office или другой
настольной зависимостью получают provider-границу. Для одной из них — старого
`HTTP_GET` — handler генерируется автоматически; остальные пять требуют
предметной реализации. Два HTTP mappings остаются работоспособным Pascal Script,
но требуют проверки сетевой политики перед эксплуатацией.

Это результат контрольной выборки, а не утверждение об автоматической
совместимости каждого файла каталога. Для каждого рабочего набора расширений
нужно строить собственный отчёт и затем компилировать сгенерированные `.wepas`.
