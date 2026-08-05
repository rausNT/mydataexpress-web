import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
REPOSITORY = ROOT.parent.parent


class WorkerAssetTests(unittest.TestCase):
    def test_template_uses_instance_local_state(self):
        unit = (ROOT / "dataexpress-wine-worker@.service").read_text(encoding="utf-8")

        self.assertIn("WorkingDirectory=/var/lib/dataexpress-wine/instances/%i/", unit)
        self.assertIn("WINEPREFIX=/var/lib/dataexpress-wine/instances/%i/prefix", unit)
        self.assertIn("XDG_CACHE_HOME=/var/lib/dataexpress-wine/instances/%i/cache", unit)
        self.assertIn("IPAddressDeny=any", unit)
        self.assertNotIn("/var/lib/dataexpress-wine/prefix", unit)

    def test_installer_deploys_per_database_worker_assets(self):
        installer = (REPOSITORY / "deploy/install-windows-worker.sh").read_text(
            encoding="utf-8"
        )

        self.assertIn('worker-tools/stage_bundle.py', installer)
        self.assertIn('dataexpress-wine-worker@.service', installer)
        self.assertIn('ln -sfn "$RELEASE_DIR" "$WORKER_ROOT/current"', installer)
        self.assertNotIn(
            'systemctl enable dataexpress-firebird.service dataexpress-wine-worker.service',
            installer,
        )


if __name__ == "__main__":
    unittest.main()
