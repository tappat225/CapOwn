# SPDX-License-Identifier: Apache-2.0
"""Focused tests for the standard-library REST client."""

from __future__ import annotations

import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from capown_client import CapownClient, ClientConfig


class ClientConfigTests(unittest.TestCase):
    def test_loads_current_config_shape(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.toml"
            path.write_text(
                'role = "client"\n'
                'master_url = "http://example.test:9230"\n'
                'client_token = "test-token"\n'
                '\n'
                '[client]\n'
                'soft_timeout = 17\n',
                encoding="utf-8",
            )

            config = ClientConfig.from_file(path)

        self.assertEqual(config.master_url, "http://example.test:9230")
        self.assertEqual(config.client_token, "test-token")
        self.assertEqual(config.request_timeout, 17)


class CapownClientTests(unittest.TestCase):
    def test_wait_accepts_task_body_returned_with_408(self) -> None:
        task = {"task_id": "task_123", "status": "pending"}
        error = urllib.error.HTTPError(
            "http://example.test/v1/tasks",
            408,
            "Request Timeout",
            {},
            io.BytesIO(json.dumps(task).encode("utf-8")),
        )
        client = CapownClient(
            ClientConfig(master_url="http://example.test", request_timeout=30)
        )

        with patch("urllib.request.urlopen", side_effect=error) as urlopen:
            result = client._dispatch_task(
                "worker_123",
                "plugin_call",
                {},
                timeout_seconds=60,
                wait=True,
            )

        self.assertEqual(result, task)
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 65)

    def test_path_parameters_are_url_encoded(self) -> None:
        client = CapownClient(ClientConfig(master_url="http://example.test"))
        with patch.object(client, "_get", return_value={}) as get:
            client.worker_get("wrk_worker/with spaces")
        get.assert_called_once_with("/v1/workers/wrk_worker%2Fwith%20spaces")

    def test_mcp_style_worker_name_is_resolved(self) -> None:
        client = CapownClient(ClientConfig(master_url="http://example.test"))
        with (
            patch.object(
                client,
                "workers_list",
                return_value=[{"worker_id": "wrk_123", "worker_name": "build-host"}],
            ),
            patch.object(client, "_get", return_value={}) as get,
        ):
            client.plugin_list("build-host")
        get.assert_called_once_with("/v1/workers/wrk_123/plugins")

    def test_task_wait_polls_until_terminal(self) -> None:
        client = CapownClient(ClientConfig(master_url="http://example.test"))
        pending = {"task_id": "task_123", "status": "running"}
        completed = {"task_id": "task_123", "status": "completed"}
        with (
            patch.object(client, "task_get", side_effect=[pending, completed]),
            patch("capown_client.time.sleep"),
        ):
            result = client.task_wait("task_123", timeout_seconds=30)
        self.assertEqual(result, completed)


if __name__ == "__main__":
    unittest.main()
