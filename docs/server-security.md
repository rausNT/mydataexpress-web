# Защита production-сервера

Установщик рассчитан на отдельную Ubuntu 24.04 x86-64 и оставляет публичными только
SSH, HTTP и HTTPS. Firebird, DataExpress и панель импорта слушают loopback-интерфейс
и доступны снаружи только через Nginx.

## Что настраивается автоматически

- UFW с политикой `deny incoming`, разрешёнными 22/80/443 и ограничением новых
  SSH-подключений;
- fail2ban для агрессивного SSH-подбора: четыре ошибки за десять минут, первый бан
  на сутки и увеличение повторных банов до недели;
- сокращённое время SSH-аутентификации, три попытки, отключённые X11, tunnel и TCP
  forwarding;
- ежедневные security updates через `unattended-upgrades`;
- Nginx rate/connection limits, короткие сетевые таймауты и безопасные заголовки;
- непривилегированные systemd-службы с изолированным `/tmp` и ограниченной записью
  в файловую систему;
- backend-порты 8080/8090 доступны только на `127.0.0.1`.

Парольный вход root намеренно не отключается автоматически: универсальный
установщик не должен лишать владельца единственного административного доступа.
После добавления и проверки собственного SSH-ключа рекомендуется установить
`PermitRootLogin prohibit-password` или создать отдельного sudo-пользователя.

## Проверка

```bash
sudo ufw status verbose
sudo fail2ban-client status sshd
sudo sshd -T | grep -E 'maxauthtries|x11forwarding|allowtcpforwarding'
sudo nginx -t
systemctl --failed
curl -fsS http://127.0.0.1/health
```

Каталог `/var/www/letsencrypt` опубликован только для ACME HTTP-01. Если для
IP-адреса выпущен сертификат Certbot 5.4+, повторный запуск установщика
автоматически добавляет TLS 1.2/1.3 на порт 443.

Rate limiting на одном VPS уменьшает ущерб от HTTP-flood и медленных клиентов, но
не может остановить объёмную атаку, забивающую сетевой канал до сервера. Для такой
угрозы нужен внешний reverse proxy/CDN или защита провайдера.

Основные параметры соответствуют документации
[Ubuntu UFW](https://ubuntu.com/server/docs/security-firewall/),
[Ubuntu OpenSSH](https://documentation.ubuntu.com/server/how-to/security/openssh-server/),
[автоматических обновлений Ubuntu](https://ubuntu.com/server/docs/how-to/software/automatic-updates/),
[Nginx request limiting](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html)
и [connection limiting](https://nginx.org/en/docs/http/ngx_http_limit_conn_module.html).
