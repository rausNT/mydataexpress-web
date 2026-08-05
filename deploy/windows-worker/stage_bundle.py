#!/usr/bin/env python3
"""Stage one database's exact extension bundle into its isolated worker."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import tempfile
from pathlib import Path


ALLOWED_SUFFIXES = {
    ".cfg", ".dat", ".dll", ".epas", ".ini", ".json", ".manifest", ".wepas", ".xml"
}
RUNTIME_RESERVED = {
    "dxwebsrv.exe", "dxwebsrv.cfg", "fbclientd.dll", "padeguc.dll"
}
ALIAS_RE = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,31}")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def atomic_replace_directory(staging: Path, destination: Path) -> None:
    previous = destination.with_name(destination.name + ".previous")
    if previous.exists():
        shutil.rmtree(previous)
    if destination.exists():
        os.replace(destination, previous)
    os.replace(staging, destination)
    if previous.exists():
        shutil.rmtree(previous)


def stage_bundle(source: Path, app_dir: Path, alias: str) -> dict[str, object]:
    if not ALIAS_RE.fullmatch(alias):
        raise ValueError(f"database alias is not routable: {alias!r}")
    source = source.resolve()
    app_dir = app_dir.resolve()
    app_dir.mkdir(parents=True, exist_ok=True)

    bundle_parent = app_dir / "database-bundles"
    bundle_parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{alias}.", dir=bundle_parent))
    web_parent = app_dir / "extensions"
    web_parent.mkdir(parents=True, exist_ok=True)
    web_staging = Path(tempfile.mkdtemp(prefix=f".{alias}.", dir=web_parent))
    files: list[dict[str, object]] = []
    blocked: list[dict[str, str]] = []
    try:
        previous_manifest = bundle_parent / alias / "compatibility-manifest.json"
        if previous_manifest.is_file():
            previous = json.loads(previous_manifest.read_text(encoding="utf-8"))
            for entry in previous.get("files", []):
                if entry.get("runtimePlacement") != "windows-search-path":
                    continue
                old_dll = app_dir / Path(str(entry["path"])).name
                if old_dll.is_file() and sha256(old_dll) == entry.get("sha256"):
                    old_dll.unlink()

        candidates = source.rglob("*") if source.is_dir() else []
        for candidate in sorted(candidates, key=lambda item: item.as_posix().casefold()):
            if candidate.is_symlink() or not candidate.is_file():
                continue
            relative = candidate.relative_to(source)
            suffix = candidate.suffix.casefold()
            if suffix not in ALLOWED_SUFFIXES:
                blocked.append({"path": relative.as_posix(), "reason": "unsupported-suffix"})
                continue
            target = staging / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(candidate, target)
            entry = {
                "path": relative.as_posix(),
                "size": target.stat().st_size,
                "sha256": sha256(target),
                "runtimePlacement": "bundle-only",
            }
            if suffix == ".wepas":
                web_target = web_staging / relative
                web_target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(candidate, web_target)
                entry["runtimePlacement"] = "web-module"
            elif suffix == ".dll":
                runtime_target = app_dir / candidate.name
                if candidate.name.casefold() in RUNTIME_RESERVED or runtime_target.exists():
                    blocked.append({"path": relative.as_posix(), "reason": "runtime-name-collision"})
                else:
                    shutil.copy2(candidate, runtime_target)
                    entry["runtimePlacement"] = "windows-search-path"
            files.append(entry)

        manifest = {
            "schemaVersion": 1,
            "databaseAlias": alias,
            "source": str(source),
            "files": files,
            "blocked": blocked,
        }
        (staging / "compatibility-manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        atomic_replace_directory(web_staging, web_parent / alias)
        atomic_replace_directory(staging, bundle_parent / alias)
        return manifest
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        shutil.rmtree(web_staging, ignore_errors=True)
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--app-dir", type=Path, required=True)
    parser.add_argument("--alias", required=True)
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    result = stage_bundle(arguments.source, arguments.app_dir, arguments.alias)
    print(json.dumps(result, ensure_ascii=False))
