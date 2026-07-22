#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import uninstall  # noqa: E402


class UninstallTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.home = Path(self.temp_dir.name)
        self.capown = self.home / ".capown"
        self.home_patch = mock.patch.object(Path, "home", return_value=self.home)
        self.home_patch.start()
        self.process_patch = mock.patch.object(uninstall, "_find_processes", return_value=[])
        self.container_patch = mock.patch.object(
            uninstall, "_docker_containers", return_value=[]
        )
        self.process_patch.start()
        self.container_patch.start()

    def tearDown(self) -> None:
        self.container_patch.stop()
        self.process_patch.stop()
        self.home_patch.stop()
        self.temp_dir.cleanup()

    def _write(self, path: Path, content: str = "data") -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def test_yes_removes_worker_programs_but_keeps_all_data(self) -> None:
        worker = self.capown / "worker"
        self._write(worker / "config.toml")
        self._write(worker / "identity.toml")
        self._write(worker / "plugins.d" / "filesystem.json")
        self._write(worker / "workspace" / "user.txt")
        self._write(worker / "worker.log")
        self._write(worker / "worker-runtime.json", "{}")
        self._write(worker / "worker-runtime.lock", "{}")
        self._write(worker / "app" / "dist" / "src" / "cli.js")
        self._write(worker / "plugins" / "third-party" / "plugin.js")
        self._write(self.capown / "bin" / "capown-worker")

        result = uninstall.main(["worker", "--yes"])

        self.assertEqual(result, 0)
        self.assertTrue((worker / "config.toml").exists())
        self.assertTrue((worker / "identity.toml").exists())
        self.assertTrue((worker / "plugins.d" / "filesystem.json").exists())
        self.assertTrue((worker / "workspace" / "user.txt").exists())
        self.assertTrue((worker / "worker.log").exists())
        self.assertFalse((worker / "worker-runtime.json").exists())
        self.assertFalse((worker / "worker-runtime.lock").exists())
        self.assertFalse((worker / "app").exists())
        self.assertFalse((worker / "plugins").exists())
        self.assertFalse((self.capown / "bin" / "capown-worker").exists())

    def test_force_removes_selected_component_data_only(self) -> None:
        master = self.capown / "master"
        client = self.capown / "client"
        self._write(master / "config.toml")
        self._write(master / "data" / "master.db")
        self._write(master / "registry" / "registry.json")
        self._write(master / "capown-master")
        self._write(self.capown / "bin" / "capown-master")
        self._write(client / "config.toml")

        result = uninstall.main(["master", "--force"])

        self.assertEqual(result, 0)
        self.assertFalse(master.exists())
        self.assertFalse((self.capown / "bin" / "capown-master").exists())
        self.assertTrue((client / "config.toml").exists())

    def test_all_yes_removes_shared_programs_but_keeps_component_data(self) -> None:
        for component in uninstall.COMPONENTS:
            self._write(self.capown / component / "config.toml")
        self._write(self.capown / "tools" / "uv" / "uv")
        self._write(self.capown / "bin" / "capown")
        self._write(self.capown / "bin" / "capown-master")
        self._write(self.capown / "bin" / "capown-worker")

        result = uninstall.main(["--all", "--yes"])

        self.assertEqual(result, 0)
        self.assertFalse((self.capown / "tools").exists())
        self.assertTrue((self.capown / "master" / "config.toml").exists())
        self.assertTrue((self.capown / "worker" / "config.toml").exists())
        self.assertTrue((self.capown / "client" / "config.toml").exists())

    def test_force_does_not_prompt(self) -> None:
        self._write(self.capown / "client" / "config.toml")
        with mock.patch.object(uninstall, "_ask_yes_no", side_effect=AssertionError):
            result = uninstall.main(["client", "--force"])
        self.assertEqual(result, 0)
        self.assertFalse((self.capown / "client").exists())


if __name__ == "__main__":
    unittest.main()
