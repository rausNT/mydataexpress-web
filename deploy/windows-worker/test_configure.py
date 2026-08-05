import configparser
import json
import tempfile
import unittest
from pathlib import Path

from configure import (
    build_routes,
    build_worker_config,
    configure_instances,
    load_config,
    plan_worker_instances,
    remote_database,
    windows_path,
)


class ConfigureWorkerTests(unittest.TestCase):
    def source(self):
        config = configparser.ConfigParser(interpolation=None)
        config.optionxform = str
        config.read_string(
            """
[Server]
Address=127.0.0.1
Port=8080
Firebird=5

[Demo_DB]
Database=/var/lib/dataexpress/databases/Demo/Demo.DXDB
Templates=/var/lib/dataexpress/databases/Demo/templates
DBPwd=masterkey

[provider:office]
Url=http://127.0.0.1:9081/
Token=secret
"""
        )
        return config

    def test_worker_uses_remote_firebird_and_wine_paths(self):
        worker = build_worker_config(
            self.source(), port=8180, firebird_host="127.0.0.1"
        )
        self.assertEqual(worker["Server"]["WindowsWorkerMode"], "1")
        self.assertEqual(worker["Server"]["ShowConnections"], "False")
        self.assertEqual(
            worker["Demo_DB"]["Database"],
            "127.0.0.1:/var/lib/dataexpress/databases/Demo/Demo.DXDB",
        )
        self.assertEqual(
            worker["Demo_DB"]["Templates"],
            r"D:\databases\Demo\templates",
        )
        self.assertEqual(worker["provider:office"]["Token"], "secret")

    def test_routes_are_exact_and_forward_audit_headers(self):
        routes = build_routes(self.source(), "127.0.0.1:8180")
        self.assertIn("location ^~ /demo_db/", routes)
        self.assertIn("proxy_pass http://127.0.0.1:8180;", routes)
        self.assertIn("proxy_set_header X-Real-IP $remote_addr;", routes)
        self.assertNotIn("masterkey", routes)
        self.assertNotIn("provider:office", routes)

    def test_plans_one_isolated_worker_per_database(self):
        source = self.source()
        source["Second_DB"] = {
            "Database": "/var/lib/dataexpress/databases/Second/Second.DXDB",
            "Templates": "/var/lib/dataexpress/databases/Second/templates",
        }
        plan = plan_worker_instances(source, 18180)
        self.assertEqual(
            plan,
            [
                {"alias": "Demo_DB", "instance": "demo_db", "port": 18180},
                {"alias": "Second_DB", "instance": "second_db", "port": 18181},
            ],
        )
        demo = build_worker_config(
            source,
            port=18180,
            firebird_host="127.0.0.1",
            database_alias="Demo_DB",
        )
        self.assertIn("Demo_DB", demo)
        self.assertNotIn("Second_DB", demo)
        self.assertIn("provider:office", demo)

    def test_writes_isolated_configs_routes_and_manifest(self):
        source = self.source()
        source["Second_DB"] = {
            "Database": "/var/lib/dataexpress/databases/Second/Second.DXDB"
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = type(
                "Args",
                (),
                {
                    "base_port": 18180,
                    "firebird_host": "127.0.0.1",
                    "data_root": "/var/lib/dataexpress",
                    "instances_root": root / "instances",
                    "routes": root / "routes.conf",
                    "manifest": root / "instances.json",
                },
            )()
            configure_instances(args, source)

            demo = load_config(root / "instances/demo_db/dxwebsrv.cfg")
            second = load_config(root / "instances/second_db/dxwebsrv.cfg")
            self.assertIn("Demo_DB", demo)
            self.assertNotIn("Second_DB", demo)
            self.assertIn("Second_DB", second)
            self.assertNotIn("Demo_DB", second)
            routes = (root / "routes.conf").read_text(encoding="utf-8")
            self.assertIn("proxy_pass http://127.0.0.1:18180;", routes)
            self.assertIn("proxy_pass http://127.0.0.1:18181;", routes)
            manifest = json.loads((root / "instances.json").read_text(encoding="utf-8"))
            self.assertEqual(len(manifest["instances"]), 2)

    def test_rejects_relative_or_unsafe_paths(self):
        with self.assertRaises(ValueError):
            windows_path("../templates")
        with self.assertRaises(ValueError):
            windows_path("/etc/dataexpress")
        with self.assertRaises(ValueError):
            remote_database("../database.fdb", "127.0.0.1")
        source = self.source()
        source.add_section("../escape")
        source["../escape"]["Database"] = "/safe/db.fdb"
        with self.assertRaises(ValueError):
            build_routes(source, "127.0.0.1:8180")
        duplicate = self.source()
        duplicate["demo_db"] = {"Database": "/safe/duplicate.fdb"}
        with self.assertRaises(ValueError):
            plan_worker_instances(duplicate, 18180)

    def test_utf8_config_loads_without_exposing_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "dxwebsrv.cfg")
            path.write_text(
                "[Server]\nPort=8080\n\n[DEMO]\n"
                "Database=/srv/demo.fdb\nTitle=Стоматология\n",
                encoding="utf-8-sig",
            )
            loaded = load_config(path)
            self.assertEqual(loaded["DEMO"]["Title"], "Стоматология")


if __name__ == "__main__":
    unittest.main()
