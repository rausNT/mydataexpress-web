import importlib.util
import os
import json
import io
import tempfile
import unittest
import zipfile
from contextlib import redirect_stdout
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("dataexpress_admin.py")
SPEC = importlib.util.spec_from_file_location("dataexpress_admin", MODULE_PATH)
ADMIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ADMIN)


class AdminImportTests(unittest.TestCase):
    def test_alias_validation(self):
        self.assertEqual(ADMIN.validate_alias("Demo_42"), "Demo_42")
        for value in ("", "42demo", "../demo", "server", "provider:test", "имя"):
            with self.assertRaises(ADMIN.ImportErrorResponse):
                ADMIN.validate_alias(value)

    def test_bearer_token_comparison(self):
        self.assertTrue(ADMIN.is_authorized("Bearer a-secret-value", "a-secret-value"))
        self.assertFalse(ADMIN.is_authorized("Bearer different", "a-secret-value"))
        self.assertFalse(ADMIN.is_authorized(None, "a-secret-value"))

    def test_audit_event_is_structured_and_does_not_invent_secret_fields(self):
        output = io.StringIO()
        with redirect_stdout(output):
            ADMIN.audit_event(
                "database_import_succeeded",
                alias="Demo",
                bytes=4096,
                ods="13.1",
            )
        line = output.getvalue().strip()
        self.assertTrue(line.startswith("AUDIT "))
        payload = json.loads(line.removeprefix("AUDIT "))
        self.assertEqual(payload["event"], "database_import_succeeded")
        self.assertEqual(payload["alias"], "Demo")
        self.assertNotIn("token", payload)

    def test_extracts_exactly_one_database(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "demo.zip"
            payload = b"\x01\x00\x00\x00" + b"x" * 4092
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("DEMO_DB.DXDB", payload)
            extracted = root / "database.dxdb"
            ADMIN.extract_database(archive, archive.name, extracted)
            self.assertEqual(extracted.read_bytes(), payload)

    def test_rejects_ambiguous_and_traversing_archives(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, members in {
                "two.zip": {"a.dxdb": b"a", "b.fdb": b"b"},
                "traversal.zip": {"../a.dxdb": b"a"},
            }.items():
                archive = root / name
                with zipfile.ZipFile(archive, "w") as output:
                    for member, payload in members.items():
                        output.writestr(member, payload)
                with self.assertRaises(ADMIN.ImportErrorResponse):
                    ADMIN.extract_database(archive, archive.name, root / f"{name}.out")

    def test_registers_connection_without_reformatting_existing_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "dxwebsrv.cfg"
            config.write_text(
                "[Server]\nLanguage=ru\nShowConnections=0\n\n"
                "[Existing]\nDatabase=/data/existing.dxdb\n",
                encoding="utf-8",
            )
            ADMIN.register_connection(
                config,
                root / "config.lock",
                "Imported",
                Path("/data/imported.dxdb"),
                Path("/data/templates"),
            )
            text = config.read_text(encoding="utf-8")
            self.assertIn("ShowConnections=1", text)
            self.assertIn("[Existing]\nDatabase=/data/existing.dxdb", text)
            self.assertIn("[Imported]\nDatabase=/data/imported.dxdb", text)
            self.assertEqual(
                [item["alias"] for item in ADMIN.read_connections(config)],
                ["Existing", "Imported"],
            )

    def test_inspector_returns_none_for_an_unsupported_tool_result(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "demo.dxdb"
            database.write_bytes(b"not a database")
            self.assertIsNone(
                ADMIN.inspect_firebird_database(database, "/usr/bin/false", os.environ.copy())
            )


if __name__ == "__main__":
    unittest.main()
