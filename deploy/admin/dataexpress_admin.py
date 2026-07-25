#!/usr/bin/env python3
"""Small authenticated database-import service for DataExpress Web Server."""

from __future__ import annotations

import configparser
import fcntl
import hmac
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import uuid
import zipfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.parse import unquote


MAX_UPLOAD_BYTES = int(os.environ.get("DX_ADMIN_MAX_UPLOAD_BYTES", 256 * 1024 * 1024))
MAX_DATABASE_BYTES = int(os.environ.get("DX_ADMIN_MAX_DATABASE_BYTES", 1024 * 1024 * 1024))
MAX_TEMPLATE_BYTES = int(os.environ.get("DX_ADMIN_MAX_TEMPLATE_BYTES", 64 * 1024 * 1024))
MAX_TEMPLATES_BYTES = int(os.environ.get("DX_ADMIN_MAX_TEMPLATES_BYTES", 256 * 1024 * 1024))
MAX_TEMPLATE_FILES = int(os.environ.get("DX_ADMIN_MAX_TEMPLATE_FILES", 2048))
ALIAS_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,31}$")
ODS_PATTERN = re.compile(r"ODS version\s+([0-9.]+)", re.IGNORECASE)
TEMPLATE_EXTENSIONS = frozenset({".docx", ".docm", ".xml", ".odt", ".ods", ".html", ".htm"})


class ImportErrorResponse(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def audit_event(event: str, **fields: object) -> None:
    """Write one journal-friendly JSON event without credentials or database content."""
    print(
        "AUDIT " + json.dumps({"event": event, **fields}, ensure_ascii=False, separators=(",", ":")),
        flush=True,
    )


def validate_alias(value: str) -> str:
    alias = value.strip()
    if not ALIAS_PATTERN.fullmatch(alias):
        raise ImportErrorResponse(
            HTTPStatus.BAD_REQUEST,
            "Имя подключения: латинская буква, затем до 31 буквы, цифры или _.",
        )
    if alias.casefold() in {"server"} or alias.casefold().startswith("provider"):
        raise ImportErrorResponse(HTTPStatus.BAD_REQUEST, "Это имя подключения зарезервировано.")
    return alias


def is_authorized(header: str | None, token: str) -> bool:
    prefix = "Bearer "
    if not header or not header.startswith(prefix):
        return False
    return hmac.compare_digest(header[len(prefix) :], token)


def _copy_bounded(
    source,
    destination: Path,
    expected_size: int,
    maximum_size: int = MAX_DATABASE_BYTES,
    too_large_message: str = "База слишком большая.",
) -> None:
    copied = 0
    with destination.open("wb") as target:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            copied += len(chunk)
            if copied > expected_size or copied > maximum_size:
                raise ImportErrorResponse(
                    HTTPStatus.REQUEST_ENTITY_TOO_LARGE, too_large_message
                )
            target.write(chunk)
    if copied != expected_size:
        raise ImportErrorResponse(HTTPStatus.BAD_REQUEST, "Размер файла в архиве не совпадает.")


def _normalized_zip_path(info: zipfile.ZipInfo) -> tuple[str, ...]:
    mode = (info.external_attr >> 16) & 0o170000
    if mode == stat.S_IFLNK:
        raise ImportErrorResponse(
            HTTPStatus.BAD_REQUEST, "Символические ссылки в ZIP запрещены."
        )
    if info.flag_bits & 0x1:
        raise ImportErrorResponse(
            HTTPStatus.BAD_REQUEST, "Зашифрованные ZIP не поддерживаются."
        )
    normalized = info.filename.replace("\\", "/")
    parts = tuple(part for part in normalized.split("/") if part)
    if (
        normalized.startswith("/")
        or ".." in parts
        or (parts and re.fullmatch(r"[A-Za-z]:", parts[0]))
    ):
        raise ImportErrorResponse(
            HTTPStatus.BAD_REQUEST, "Небезопасный путь внутри ZIP."
        )
    return parts


def _template_destination(parts: tuple[str, ...]) -> PurePosixPath | None:
    if not parts:
        return None
    lower_parts = tuple(part.casefold() for part in parts)
    if "templates" in lower_parts:
        relative_parts = parts[lower_parts.index("templates") + 1 :]
    elif len(parts) == 1:
        relative_parts = parts
    else:
        return None
    if not relative_parts:
        return None
    destination = PurePosixPath(*relative_parts)
    if destination.suffix.casefold() not in TEMPLATE_EXTENSIONS:
        return None
    return destination


def _extract_template_entries(
    archive: zipfile.ZipFile,
    entries: list[tuple[zipfile.ZipInfo, PurePosixPath]],
    output_directory: Path,
) -> list[str]:
    if len(entries) > MAX_TEMPLATE_FILES:
        raise ImportErrorResponse(
            HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
            "В архиве слишком много файлов шаблонов.",
        )
    total_size = sum(info.file_size for info, _ in entries)
    if total_size > MAX_TEMPLATES_BYTES:
        raise ImportErrorResponse(
            HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
            "Комплект шаблонов слишком большой.",
        )

    seen: set[str] = set()
    extracted: list[str] = []
    for info, relative in entries:
        key = relative.as_posix().casefold()
        if key in seen:
            raise ImportErrorResponse(
                HTTPStatus.BAD_REQUEST,
                f"Повторяющийся путь шаблона: {relative.as_posix()}",
            )
        seen.add(key)
        if info.file_size > MAX_TEMPLATE_BYTES:
            raise ImportErrorResponse(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                f"Шаблон слишком большой: {relative.name}",
            )
        destination = output_directory.joinpath(*relative.parts)
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
        with archive.open(info, "r") as source:
            _copy_bounded(
                source,
                destination,
                info.file_size,
                MAX_TEMPLATE_BYTES,
                f"Шаблон слишком большой: {relative.name}",
            )
        os.chmod(destination, 0o640)
        extracted.append(relative.as_posix())
    return extracted


def extract_database_bundle(
    upload_path: Path,
    original_name: str,
    output_path: Path,
    templates_directory: Path | None = None,
) -> list[str]:
    suffix = Path(original_name).suffix.casefold()
    if suffix in {".dxdb", ".fdb"}:
        size = upload_path.stat().st_size
        if size > MAX_DATABASE_BYTES:
            raise ImportErrorResponse(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "База слишком большая.")
        with upload_path.open("rb") as source:
            _copy_bounded(source, output_path, size)
        return []

    if suffix != ".zip":
        raise ImportErrorResponse(
            HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
            "Поддерживаются .DXDB, .FDB и ZIP с одной базой внутри.",
        )

    try:
        with zipfile.ZipFile(upload_path) as archive:
            candidates = []
            template_entries: list[tuple[zipfile.ZipInfo, PurePosixPath]] = []
            for info in archive.infolist():
                parts = _normalized_zip_path(info)
                if info.is_dir():
                    continue
                suffix = PurePosixPath(*parts).suffix.casefold()
                if suffix in {".dxdb", ".fdb"}:
                    candidates.append(info)
                    continue
                template_destination = _template_destination(parts)
                if template_destination is not None:
                    template_entries.append((info, template_destination))

            if len(candidates) != 1:
                raise ImportErrorResponse(
                    HTTPStatus.BAD_REQUEST,
                    "В ZIP должна находиться ровно одна база .DXDB или .FDB.",
                )

            item = candidates[0]
            if item.file_size > MAX_DATABASE_BYTES:
                raise ImportErrorResponse(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "База слишком большая.")
            with archive.open(item, "r") as source:
                _copy_bounded(source, output_path, item.file_size)
            if templates_directory is None:
                return []
            templates_directory.mkdir(parents=True, exist_ok=True, mode=0o750)
            return _extract_template_entries(
                archive, template_entries, templates_directory
            )
    except zipfile.BadZipFile as exc:
        raise ImportErrorResponse(HTTPStatus.BAD_REQUEST, "Повреждённый ZIP-архив.") from exc


def extract_database(upload_path: Path, original_name: str, output_path: Path) -> None:
    extract_database_bundle(upload_path, original_name, output_path)


def extract_templates(
    upload_path: Path, original_name: str, output_directory: Path
) -> list[str]:
    suffix = Path(original_name).suffix.casefold()
    if suffix in TEMPLATE_EXTENSIONS:
        safe_name = original_name.replace("\\", "/").split("/")[-1]
        if not safe_name or Path(safe_name).suffix.casefold() not in TEMPLATE_EXTENSIONS:
            raise ImportErrorResponse(
                HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "Неподдерживаемый формат шаблона."
            )
        size = upload_path.stat().st_size
        if size > MAX_TEMPLATE_BYTES:
            raise ImportErrorResponse(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Шаблон слишком большой."
            )
        output_directory.mkdir(parents=True, exist_ok=True, mode=0o750)
        destination = output_directory / safe_name
        with upload_path.open("rb") as source:
            _copy_bounded(
                source,
                destination,
                size,
                MAX_TEMPLATE_BYTES,
                "Шаблон слишком большой.",
            )
        os.chmod(destination, 0o640)
        return [safe_name]

    if suffix != ".zip":
        raise ImportErrorResponse(
            HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
            "Поддерживаются DOCX, DOCM, XML, ODT, ODS, HTML или ZIP с шаблонами.",
        )
    try:
        with zipfile.ZipFile(upload_path) as archive:
            entries: list[tuple[zipfile.ZipInfo, PurePosixPath]] = []
            for info in archive.infolist():
                parts = _normalized_zip_path(info)
                if info.is_dir():
                    continue
                destination = _template_destination(parts)
                if destination is not None:
                    entries.append((info, destination))
            if not entries:
                raise ImportErrorResponse(
                    HTTPStatus.BAD_REQUEST, "В ZIP не найдены поддерживаемые шаблоны."
                )
            output_directory.mkdir(parents=True, exist_ok=True, mode=0o750)
            return _extract_template_entries(archive, entries, output_directory)
    except zipfile.BadZipFile as exc:
        raise ImportErrorResponse(HTTPStatus.BAD_REQUEST, "Повреждённый ZIP-архив.") from exc


def inspect_firebird_database(
    database_path: Path, gstat_path: str, base_env: dict[str, str]
) -> str | None:
    process = subprocess.run(
        [gstat_path, "-h", str(database_path)],
        capture_output=True,
        check=False,
        env=base_env,
        text=True,
        timeout=30,
    )
    output = f"{process.stdout}\n{process.stderr}"
    match = ODS_PATTERN.search(output)
    if process.returncode != 0 or not match:
        return None
    return match.group(1)


def _run_gbak(
    executable: str,
    arguments: list[str],
    base_env: dict[str, str],
    error_message: str,
) -> None:
    process = subprocess.run(
        [executable, *arguments],
        capture_output=True,
        check=False,
        env=base_env,
        text=True,
        timeout=600,
    )
    if process.returncode != 0:
        raise ImportErrorResponse(
            HTTPStatus.UNPROCESSABLE_ENTITY,
            f"{error_message}: {(process.stderr or process.stdout).strip()[:500]}",
        )


def normalize_firebird_database(database_path: Path, settings: dict) -> str:
    modern_ods = inspect_firebird_database(
        database_path,
        settings["modern_gstat_path"],
        settings["modern_firebird_env"],
    )
    if modern_ods:
        return modern_ods

    source_profile = None
    source_ods = None
    for profile in settings["migration_sources"]:
        source_ods = inspect_firebird_database(
            database_path,
            profile["gstat_path"],
            profile["env"],
        )
        if source_ods:
            source_profile = profile
            break
    if source_profile is None or source_ods is None:
        raise ImportErrorResponse(
            HTTPStatus.UNPROCESSABLE_ENTITY,
            "Файл не распознан как поддерживаемая база Firebird ODS 11, 12 или 13.",
        )

    backup_path = database_path.with_suffix(".fbk")
    normalized_path = database_path.with_suffix(".normalized")
    _run_gbak(
        source_profile["gbak_path"],
        [
            "-b",
            "-user",
            "sysdba",
            "-password",
            "masterkey",
            str(database_path),
            str(backup_path),
        ],
        source_profile["env"],
        "Не удалось создать переносимую резервную копию",
    )
    try:
        _run_gbak(
            settings["modern_gbak_path"],
            [
                "-c",
                "-user",
                "sysdba",
                "-password",
                "masterkey",
                str(backup_path),
                str(normalized_path),
            ],
            settings["modern_firebird_env"],
            "Не удалось восстановить базу в Firebird 5",
        )
        normalized_ods = inspect_firebird_database(
            normalized_path,
            settings["modern_gstat_path"],
            settings["modern_firebird_env"],
        )
        if not normalized_ods:
            raise ImportErrorResponse(
                HTTPStatus.UNPROCESSABLE_ENTITY,
                "Восстановленная база не прошла проверку Firebird 5.",
            )
        os.replace(normalized_path, database_path)
        return f"{source_ods} → {normalized_ods}"
    finally:
        backup_path.unlink(missing_ok=True)
        normalized_path.unlink(missing_ok=True)


def ensure_web_schema(database_path: Path, settings: dict) -> None:
    migration = """
SET AUTODDL OFF;
SET TERM ^ ;
EXECUTE BLOCK AS
BEGIN
  IF (NOT EXISTS(
    SELECT 1
    FROM RDB$RELATIONS
    WHERE RDB$RELATION_NAME = 'DX_IMAGES'
  )) THEN
    EXECUTE STATEMENT
      'CREATE TABLE DX_IMAGES (' ||
      'ID INTEGER, ' ||
      'NAME VARCHAR(50), ' ||
      'IMG_100 BLOB SUB_TYPE 0 SEGMENT SIZE 512, ' ||
      'IMG_150 BLOB SUB_TYPE 0 SEGMENT SIZE 512, ' ||
      'IMG_200 BLOB SUB_TYPE 0 SEGMENT SIZE 512, ' ||
      'LASTMODIFIED TIMESTAMP)';
  IF (NOT EXISTS(
    SELECT 1
    FROM RDB$RELATION_FIELDS
    WHERE RDB$RELATION_NAME = 'DX_MAIN'
      AND RDB$FIELD_NAME = 'LASTMODIFIED'
  )) THEN
    EXECUTE STATEMENT 'ALTER TABLE DX_MAIN ADD LASTMODIFIED TIMESTAMP';
END^
SET TERM ; ^
COMMIT;
UPDATE DX_MAIN
SET LASTMODIFIED = CURRENT_TIMESTAMP
WHERE LASTMODIFIED IS NULL;
COMMIT;
QUIT;
"""
    process = subprocess.run(
        [
            settings["modern_isql_path"],
            "-user",
            "sysdba",
            "-password",
            "masterkey",
            str(database_path),
        ],
        input=migration,
        capture_output=True,
        check=False,
        env=settings["modern_firebird_env"],
        text=True,
        timeout=120,
    )
    output = f"{process.stdout}\n{process.stderr}"
    if process.returncode != 0 or re.search(
        r"Statement failed|SQL error|Dynamic SQL Error", output, re.IGNORECASE
    ):
        raise ImportErrorResponse(
            HTTPStatus.UNPROCESSABLE_ENTITY,
            f"Не удалось обновить служебную схему DataExpress: {output.strip()[:500]}",
        )


def read_connections(config_path: Path) -> list[dict[str, str]]:
    parser = configparser.ConfigParser(interpolation=None)
    parser.optionxform = str
    parser.read(config_path, encoding="utf-8")
    result = []
    for section in parser.sections():
        if section.casefold() == "server" or section.casefold().startswith("provider:"):
            continue
        result.append(
            {
                "alias": section,
                "url": f"/{section.casefold()}/",
                "database": parser.get(section, "Database", fallback=""),
                "templates": parser.get(section, "Templates", fallback=""),
            }
        )
    return result


def install_templates(
    target_directory: Path, incoming_directory: Path, database_root: Path
) -> int:
    root = database_root.resolve()
    target = target_directory.resolve(strict=False)
    if target == root or root not in target.parents:
        raise ImportErrorResponse(
            HTTPStatus.BAD_REQUEST,
            "Каталог шаблонов должен находиться внутри каталога баз DataExpress.",
        )

    target.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
    prepared = Path(
        tempfile.mkdtemp(prefix=".templates-new-", dir=target.parent)
    )
    backup = target.parent / f".templates-old-{uuid.uuid4().hex}"
    installed = 0
    try:
        if target.exists():
            shutil.copytree(target, prepared, dirs_exist_ok=True)
        for source in incoming_directory.rglob("*"):
            if not source.is_file():
                continue
            relative = source.relative_to(incoming_directory)
            destination = prepared / relative
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
            shutil.copy2(source, destination)
            os.chmod(destination, 0o640)
            installed += 1
        if installed == 0:
            raise ImportErrorResponse(
                HTTPStatus.BAD_REQUEST, "Нет шаблонов для установки."
            )

        if target.exists():
            target.rename(backup)
        try:
            prepared.rename(target)
        except Exception:
            if backup.exists() and not target.exists():
                backup.rename(target)
            raise
        shutil.rmtree(backup, ignore_errors=True)
        return installed
    finally:
        shutil.rmtree(prepared, ignore_errors=True)


def _enable_connection_discovery(text: str) -> str:
    server_match = re.search(r"(?ims)^\[Server\]\s*$.*?(?=^\[|\Z)", text)
    if not server_match:
        raise ImportErrorResponse(HTTPStatus.INTERNAL_SERVER_ERROR, "В конфигурации нет секции Server.")
    block = server_match.group(0)
    if re.search(r"(?im)^ShowConnections\s*=", block):
        updated = re.sub(r"(?im)^ShowConnections\s*=.*$", "ShowConnections=1", block)
    else:
        updated = block.rstrip() + "\nShowConnections=1\n\n"
    return text[: server_match.start()] + updated + text[server_match.end() :]


def register_connection(
    config_path: Path,
    lock_path: Path,
    alias: str,
    database_path: Path,
    templates_path: Path,
) -> None:
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        existing = {item["alias"].casefold() for item in read_connections(config_path)}
        if alias.casefold() in existing:
            raise ImportErrorResponse(HTTPStatus.CONFLICT, "Подключение с таким именем уже существует.")

        current = config_path.read_text(encoding="utf-8")
        current = _enable_connection_discovery(current)
        section = (
            f"\n[{alias}]\n"
            f"Database={database_path}\n"
            f"Templates={templates_path}\n"
            "SessionTime=30\n"
            "DBPwd=\n"
            "KeepMetadata=1\n"
        )
        fd, temporary_name = tempfile.mkstemp(prefix=".dxwebsrv.", dir=config_path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as temporary:
                temporary.write(current.rstrip() + "\n" + section)
                temporary.flush()
                os.fsync(temporary.fileno())
            os.chmod(temporary_name, 0o660)
            os.replace(temporary_name, config_path)
        finally:
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)


class AdminHandler(BaseHTTPRequestHandler):
    server_version = "DataExpressAdmin/0.1"

    @property
    def settings(self):
        return self.server.settings

    def log_message(self, format_string: str, *args) -> None:
        print(f"{self.client_address[0]} - {format_string % args}", flush=True)

    def client_ip(self) -> str:
        # The service listens on loopback only, so X-Real-IP can only be supplied by Nginx.
        return (self.headers.get("X-Real-IP") or self.client_address[0]).strip()[:64]

    def send_json(self, status: int, payload: dict | list) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def send_error_json(self, error: ImportErrorResponse) -> None:
        self.send_json(error.status, {"ok": False, "error": str(error)})

    def require_auth(self) -> bool:
        if is_authorized(self.headers.get("Authorization"), self.settings["token"]):
            return True
        audit_event(
            "admin_authentication_failed",
            client=self.client_ip(),
            method=self.command,
            path=self.path[:160],
        )
        self.send_json(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "Неверный ключ администратора."})
        return False

    def do_GET(self) -> None:
        if self.path in {"/admin", "/admin/"}:
            content = self.settings["html_path"].read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
            return
        if self.path == "/admin/api/health":
            self.send_json(HTTPStatus.OK, {"ok": True, "service": "dataexpress-admin"})
            return
        if self.path == "/admin/api/databases":
            if not self.require_auth():
                return
            self.send_json(HTTPStatus.OK, {"ok": True, "databases": read_connections(self.settings["config_path"])})
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Маршрут не найден."})

    def upload_templates(self) -> None:
        raw_alias = self.headers.get("X-Database-Alias", "").strip()[:64]
        original_name = unquote(self.headers.get("X-Filename", ""))
        content_length = 0
        try:
            alias = validate_alias(raw_alias)
            connection = next(
                (
                    item
                    for item in read_connections(self.settings["config_path"])
                    if item["alias"].casefold() == alias.casefold()
                ),
                None,
            )
            if connection is None:
                raise ImportErrorResponse(
                    HTTPStatus.NOT_FOUND, "Подключение с таким именем не найдено."
                )
            if not connection["templates"]:
                raise ImportErrorResponse(
                    HTTPStatus.CONFLICT,
                    "Для подключения не настроен каталог шаблонов.",
                )

            try:
                content_length = int(self.headers.get("Content-Length", "0"))
            except ValueError as exc:
                raise ImportErrorResponse(
                    HTTPStatus.LENGTH_REQUIRED, "Нужен корректный Content-Length."
                ) from exc
            if content_length <= 0:
                raise ImportErrorResponse(HTTPStatus.LENGTH_REQUIRED, "Пустой файл.")
            if content_length > MAX_UPLOAD_BYTES:
                raise ImportErrorResponse(
                    HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                    "Комплект шаблонов слишком большой.",
                )

            root = self.settings["database_root"]
            staging_root = root / ".staging"
            staging_root.mkdir(parents=True, exist_ok=True, mode=0o700)
            with tempfile.TemporaryDirectory(
                prefix=f"{alias}-templates-", dir=staging_root
            ) as temporary:
                temporary_path = Path(temporary)
                upload_path = temporary_path / "upload.bin"
                remaining = content_length
                with upload_path.open("wb") as upload:
                    while remaining:
                        chunk = self.rfile.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise ImportErrorResponse(
                                HTTPStatus.BAD_REQUEST,
                                "Передача файла оборвалась.",
                            )
                        upload.write(chunk)
                        remaining -= len(chunk)

                incoming = temporary_path / "templates"
                names = extract_templates(upload_path, original_name, incoming)
                installed = install_templates(
                    Path(connection["templates"]), incoming, root
                )

            self.send_json(
                HTTPStatus.CREATED,
                {
                    "ok": True,
                    "alias": connection["alias"],
                    "templates": installed,
                    "files": names,
                    "message": "Шаблоны установлены и доступны для печати.",
                },
            )
            audit_event(
                "template_import_succeeded",
                client=self.client_ip(),
                alias=connection["alias"],
                filename=original_name.replace("\\", "/").split("/")[-1][:160],
                bytes=content_length,
                templates=installed,
            )
        except ImportErrorResponse as error:
            audit_event(
                "template_import_failed",
                client=self.client_ip(),
                alias=raw_alias,
                filename=original_name.replace("\\", "/").split("/")[-1][:160],
                bytes=content_length,
                status=int(error.status),
                reason=str(error)[:240],
            )
            self.send_error_json(error)
        except (OSError, shutil.Error) as error:
            audit_event(
                "template_import_failed",
                client=self.client_ip(),
                alias=raw_alias,
                filename=original_name.replace("\\", "/").split("/")[-1][:160],
                bytes=content_length,
                status=int(HTTPStatus.INTERNAL_SERVER_ERROR),
                reason=type(error).__name__,
            )
            self.send_error_json(
                ImportErrorResponse(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    f"Ошибка установки шаблонов: {error}",
                )
            )

    def do_POST(self) -> None:
        if self.path not in {"/admin/api/databases", "/admin/api/templates"}:
            self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Маршрут не найден."})
            return
        if not self.require_auth():
            return
        if self.path == "/admin/api/templates":
            self.upload_templates()
            return

        raw_alias = self.headers.get("X-Database-Alias", "").strip()[:64]
        original_name = unquote(self.headers.get("X-Filename", ""))
        content_length = 0
        try:
            alias = validate_alias(raw_alias)
            try:
                content_length = int(self.headers.get("Content-Length", "0"))
            except ValueError as exc:
                raise ImportErrorResponse(HTTPStatus.LENGTH_REQUIRED, "Нужен корректный Content-Length.") from exc
            if content_length <= 0:
                raise ImportErrorResponse(HTTPStatus.LENGTH_REQUIRED, "Пустой файл.")
            if content_length > MAX_UPLOAD_BYTES:
                raise ImportErrorResponse(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Архив слишком большой.")

            root = self.settings["database_root"]
            final_directory = root / alias
            if final_directory.exists():
                raise ImportErrorResponse(HTTPStatus.CONFLICT, "Каталог подключения уже существует.")

            staging_root = root / ".staging"
            staging_root.mkdir(parents=True, exist_ok=True, mode=0o700)
            with tempfile.TemporaryDirectory(prefix=f"{alias}-", dir=staging_root) as temporary:
                temporary_path = Path(temporary)
                upload_path = temporary_path / "upload.bin"
                remaining = content_length
                with upload_path.open("wb") as upload:
                    while remaining:
                        chunk = self.rfile.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise ImportErrorResponse(HTTPStatus.BAD_REQUEST, "Передача файла оборвалась.")
                        upload.write(chunk)
                        remaining -= len(chunk)

                database_path = temporary_path / f"{alias}.DXDB"
                extracted_templates = temporary_path / "templates"
                template_names = extract_database_bundle(
                    upload_path,
                    original_name,
                    database_path,
                    extracted_templates,
                )
                ods = normalize_firebird_database(database_path, self.settings)
                ensure_web_schema(database_path, self.settings)

                prepared_directory = root / f".new-{alias}-{os.getpid()}"
                templates_path = prepared_directory / "templates"
                prepared_directory.mkdir(mode=0o750)
                if extracted_templates.exists():
                    shutil.move(str(extracted_templates), templates_path)
                else:
                    templates_path.mkdir(mode=0o750)
                shutil.move(str(database_path), prepared_directory / f"{alias}.DXDB")
                os.chmod(prepared_directory / f"{alias}.DXDB", 0o640)
                prepared_directory.rename(final_directory)

            final_database = final_directory / f"{alias}.DXDB"
            final_templates = final_directory / "templates"
            try:
                register_connection(
                    self.settings["config_path"],
                    self.settings["lock_path"],
                    alias,
                    final_database,
                    final_templates,
                )
            except Exception:
                shutil.rmtree(final_directory, ignore_errors=True)
                raise

            self.send_json(
                HTTPStatus.CREATED,
                {
                    "ok": True,
                    "alias": alias,
                    "url": f"/{alias.casefold()}/",
                    "ods": ods,
                    "templates": len(template_names),
                    "message": "База зарегистрирована; сервер применяет конфигурацию.",
                },
            )
            audit_event(
                "database_import_succeeded",
                client=self.client_ip(),
                alias=alias,
                filename=Path(original_name).name[:160],
                bytes=content_length,
                ods=ods,
                templates=len(template_names),
            )
        except ImportErrorResponse as error:
            audit_event(
                "database_import_failed",
                client=self.client_ip(),
                alias=raw_alias,
                filename=Path(original_name).name[:160],
                bytes=content_length,
                status=int(error.status),
                reason=str(error)[:240],
            )
            self.send_error_json(error)
        except (OSError, subprocess.SubprocessError) as error:
            audit_event(
                "database_import_failed",
                client=self.client_ip(),
                alias=raw_alias,
                filename=Path(original_name).name[:160],
                bytes=content_length,
                status=int(HTTPStatus.INTERNAL_SERVER_ERROR),
                reason=type(error).__name__,
            )
            self.send_error_json(
                ImportErrorResponse(HTTPStatus.INTERNAL_SERVER_ERROR, f"Ошибка импорта: {error}")
            )


def build_settings() -> dict:
    token = os.environ.get("DX_ADMIN_TOKEN", "")
    if len(token) < 24:
        raise SystemExit("DX_ADMIN_TOKEN must contain at least 24 characters")
    legacy_root = os.environ.get("DX_FIREBIRD25_ROOT", "/opt/dataexpress/runtime/firebird25")
    modern_root = os.environ.get("DX_FIREBIRD5_ROOT", "/opt/dataexpress/runtime/firebird5")
    compat_root = os.environ.get("DX_COMPAT_ROOT", "/opt/dataexpress/runtime/compat")
    legacy_env = os.environ.copy()
    legacy_env["FIREBIRD"] = legacy_root
    legacy_env["LD_LIBRARY_PATH"] = f"{legacy_root}/lib:{compat_root}"
    modern_env = os.environ.copy()
    modern_env["FIREBIRD"] = modern_root
    modern_env["LD_LIBRARY_PATH"] = f"{modern_root}/lib"
    system_env = os.environ.copy()
    system_env.pop("FIREBIRD", None)
    system_env.pop("LD_LIBRARY_PATH", None)
    return {
        "token": token,
        "config_path": Path(os.environ.get("DX_CONFIG", "/etc/dataexpress/dxwebsrv.cfg")),
        "lock_path": Path(os.environ.get("DX_CONFIG_LOCK", "/var/lib/dataexpress/config.lock")),
        "database_root": Path(
            os.environ.get("DX_DATABASE_ROOT", "/var/lib/dataexpress/databases")
        ),
        "html_path": Path(
            os.environ.get("DX_ADMIN_HTML", "/opt/dataexpress/admin/index.html")
        ),
        "modern_gstat_path": os.environ.get("DX_FIREBIRD5_GSTAT", f"{modern_root}/bin/gstat"),
        "modern_gbak_path": os.environ.get("DX_FIREBIRD5_GBAK", f"{modern_root}/bin/gbak"),
        "modern_isql_path": os.environ.get("DX_FIREBIRD5_ISQL", f"{modern_root}/bin/isql"),
        "modern_firebird_env": modern_env,
        "migration_sources": [
            {
                "gstat_path": os.environ.get(
                    "DX_FIREBIRD25_GSTAT", f"{legacy_root}/bin/gstat"
                ),
                "gbak_path": os.environ.get(
                    "DX_FIREBIRD25_GBAK", f"{legacy_root}/bin/gbak"
                ),
                "env": legacy_env,
            },
            {
                "gstat_path": os.environ.get("DX_FIREBIRD3_GSTAT", "/usr/bin/fbstat"),
                "gbak_path": os.environ.get("DX_FIREBIRD3_GBAK", "/usr/bin/gbak"),
                "env": system_env,
            },
        ],
    }


def main() -> None:
    host = os.environ.get("DX_ADMIN_HOST", "127.0.0.1")
    port = int(os.environ.get("DX_ADMIN_PORT", "8090"))
    server = ThreadingHTTPServer((host, port), AdminHandler)
    server.settings = build_settings()
    print(f"DataExpress admin listening on {host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
