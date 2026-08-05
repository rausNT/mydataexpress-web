import tempfile
import unittest
from pathlib import Path

from stage_bundle import stage_bundle


class StageBundleTests(unittest.TestCase):
    def test_rejects_unsafe_database_alias(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, "not routable"):
                stage_bundle(root / "source", root / "worker", "../other")

    def test_stages_only_selected_database_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "extensions/DEMO"
            app = root / "worker"
            source.mkdir(parents=True)
            (source / "module.wepas").write_text("function Demo: String;", encoding="utf-8")
            (source / "module.epas").write_text("function Demo: String;", encoding="utf-8")
            (source / "helper.dll").write_bytes(b"database-specific-dll")
            (source / "notes.txt").write_text("not executable", encoding="utf-8")

            manifest = stage_bundle(source, app, "DEMO")

            self.assertTrue((app / "extensions/DEMO/module.wepas").is_file())
            self.assertTrue((app / "database-bundles/DEMO/module.epas").is_file())
            self.assertEqual((app / "helper.dll").read_bytes(), b"database-specific-dll")
            self.assertEqual(len(manifest["files"]), 3)
            self.assertEqual(manifest["blocked"][0]["reason"], "unsupported-suffix")

    def test_removes_stale_files_and_blocks_runtime_collisions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "extensions/DEMO"
            app = root / "worker"
            source.mkdir(parents=True)
            app.mkdir()
            (source / "old.wepas").write_text("old", encoding="utf-8")
            (source / "custom.dll").write_bytes(b"old-dll")
            stage_bundle(source, app, "DEMO")

            (source / "old.wepas").unlink()
            (source / "custom.dll").unlink()
            (source / "new.wepas").write_text("new", encoding="utf-8")
            (source / "fbclientd.dll").write_bytes(b"collision")
            (app / "fbclientd.dll").write_bytes(b"runtime")
            manifest = stage_bundle(source, app, "DEMO")

            self.assertFalse((app / "extensions/DEMO/old.wepas").exists())
            self.assertFalse((app / "custom.dll").exists())
            self.assertTrue((app / "extensions/DEMO/new.wepas").is_file())
            self.assertEqual((app / "fbclientd.dll").read_bytes(), b"runtime")
            self.assertTrue(
                any(item["reason"] == "runtime-name-collision" for item in manifest["blocked"])
            )


if __name__ == "__main__":
    unittest.main()
