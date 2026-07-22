# SPDX-License-Identifier: Apache-2.0
"""Minimal CapOwn REST Client -- task and plugin operations.

Standard-library only (urllib and tomllib). Targets the current v1 protocol.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import tomllib
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_CONFIG_PATH = Path.home() / ".capown" / "client" / "config.toml"
TERMINAL_TASK_STATUSES = frozenset({"completed", "failed", "timeout", "canceled"})


@dataclass
class ClientConfig:
    master_url: str = "http://localhost:9230"
    client_token: str = ""
    request_timeout: int = 30

    @classmethod
    def from_file(cls, path: str | os.PathLike[str] | None = None) -> "ClientConfig":
        """Load a client config, defaulting to ~/.capown/client/config.toml."""
        config_path = Path(
            path
            or os.environ.get("CAPOWN_CLIENT_CONFIG")
            or DEFAULT_CONFIG_PATH
        ).expanduser()
        with config_path.open("rb") as config_file:
            raw = tomllib.load(config_file)

        role = raw.get("role")
        if role is not None and role != "client":
            raise ValueError(f"config role must be 'client', got {role!r}")

        client_section = raw.get("client", {})
        if not isinstance(client_section, dict):
            raise ValueError("config [client] must be a TOML table")

        master_url = raw.get("master_url", cls.master_url)
        client_token = raw.get("client_token", cls.client_token)
        timeout = client_section.get(
            "soft_timeout",
            client_section.get("request_timeout", raw.get("request_timeout", cls.request_timeout)),
        )
        if not isinstance(master_url, str) or not master_url.strip():
            raise ValueError("master_url must be a non-empty string")
        if not isinstance(client_token, str):
            raise ValueError("client_token must be a string")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
            raise ValueError("client.soft_timeout must be a positive number")

        return cls(
            master_url=master_url.strip(),
            client_token=client_token,
            request_timeout=timeout,
        )


@dataclass
class ApiError(Exception):
    code: str
    message: str
    details: Any = None
    status: int = 0

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"


class CapownClient:
    """HTTP client for the CapOwn Master v1 API."""

    def __init__(self, config: ClientConfig) -> None:
        self.config = config

    # ------------------------------------------------------------------
    # Internal HTTP helpers
    # ------------------------------------------------------------------

    def _build_url(self, path: str) -> str:
        base = self.config.master_url.rstrip("/")
        if not path.startswith("/"):
            path = "/" + path
        return base + path

    @staticmethod
    def _path_segment(value: str) -> str:
        return urllib.parse.quote(value, safe="")

    def _headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        if self.config.client_token:
            headers["Authorization"] = f"Bearer {self.config.client_token}"
        return headers

    def _request(
        self,
        method: str,
        path: str,
        body: Any = None,
        params: dict[str, str] | None = None,
        accepted_statuses: set[int] | None = None,
        timeout: float | None = None,
    ) -> Any:
        url = self._build_url(path)
        if params:
            url += "?" + urllib.parse.urlencode(params)

        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            url,
            data=data,
            headers=self._headers(),
            method=method,
        )

        try:
            with urllib.request.urlopen(
                req,
                timeout=self.config.request_timeout if timeout is None else timeout,
            ) as resp:
                raw = resp.read().decode("utf-8")
                if raw:
                    try:
                        return json.loads(raw)
                    except json.JSONDecodeError as exc:
                        raise ApiError(
                            code="invalid_response",
                            message="Master returned invalid JSON",
                            status=getattr(resp, "status", 0),
                        ) from exc
                return None
        except urllib.error.HTTPError as exc:
            status = exc.code
            response_body: Any = None
            try:
                response_body = json.loads(exc.read().decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                pass
            if accepted_statuses and status in accepted_statuses and response_body is not None:
                return response_body
            if isinstance(response_body, dict) and isinstance(response_body.get("error"), dict):
                err = response_body["error"]
                raise ApiError(
                    code=err.get("code", "http_error"),
                    message=err.get("message", str(exc)),
                    details=err.get("details"),
                    status=status,
                ) from exc
            raise ApiError(
                code="http_error",
                message=f"HTTP {status}: {exc.reason}",
                status=status,
            ) from exc
        except (urllib.error.URLError, TimeoutError, socket.timeout) as exc:
            reason = getattr(exc, "reason", exc)
            raise ApiError(
                code="connection_error",
                message=str(reason),
            ) from exc

    def _get(self, path: str) -> Any:
        return self._request("GET", path)

    def _post(
        self,
        path: str,
        body: Any = None,
        params: dict[str, str] | None = None,
        *,
        accepted_statuses: set[int] | None = None,
        timeout: float | None = None,
    ) -> Any:
        return self._request(
            "POST",
            path,
            body,
            params,
            accepted_statuses=accepted_statuses,
            timeout=timeout,
        )

    def _put(self, path: str, body: Any = None) -> Any:
        return self._request("PUT", path, body)

    def _delete(self, path: str) -> None:
        self._request("DELETE", path)

    # ------------------------------------------------------------------
    # Meta operations
    # ------------------------------------------------------------------

    def health(self) -> dict[str, Any]:
        return self._get("/v1/health")

    def meta(self) -> dict[str, Any]:
        return self._get("/v1/meta")

    # ------------------------------------------------------------------
    # Worker operations
    # ------------------------------------------------------------------

    def workers_list(self) -> list[dict[str, Any]]:
        data = self._get("/v1/workers")
        if isinstance(data, dict):
            return data.get("items", [])
        return data or []

    def _resolve_worker_id(self, worker: str) -> str:
        """Resolve the MCP-style Worker ID-or-name argument to an ID."""
        if worker.startswith("wrk_"):
            return worker
        for item in self.workers_list():
            if item.get("worker_name") == worker:
                worker_id = item.get("worker_id")
                if isinstance(worker_id, str) and worker_id:
                    return worker_id
        raise ApiError(
            code="worker_not_found",
            message=f"Worker not found: {worker}",
            status=404,
        )

    def worker_get(self, worker: str) -> dict[str, Any]:
        worker_id = self._resolve_worker_id(worker)
        return self._get(f"/v1/workers/{self._path_segment(worker_id)}")

    def plugin_list(self, worker: str) -> list[dict[str, Any]]:
        worker_id = self._resolve_worker_id(worker)
        data = self._get(f"/v1/workers/{self._path_segment(worker_id)}/plugins")
        if isinstance(data, dict):
            return data.get("items", [])
        return data or []

    # ------------------------------------------------------------------
    # Task operations
    # ------------------------------------------------------------------

    def _dispatch_task(
        self,
        worker_id: str,
        task_type: str,
        params: dict[str, Any],
        timeout_seconds: int = 120,
        wait: bool = False,
    ) -> dict[str, Any]:
        qparams = {"wait": "true"} if wait else None
        request_timeout = None
        if wait:
            # Master bounds synchronous waits at 60 seconds. Add a small
            # transport margin so a completed task is not cut off locally.
            request_timeout = max(self.config.request_timeout, min(timeout_seconds, 60) + 5)
        return self._post(
            "/v1/tasks",
            {
                "target_worker": worker_id,
                "payload": {"task_type": task_type, "params": params},
                "timeout_seconds": timeout_seconds,
            },
            params=qparams,
            accepted_statuses={408} if wait else None,
            timeout=request_timeout,
        )

    def task_get(self, task_id: str) -> dict[str, Any]:
        return self._get(f"/v1/tasks/{self._path_segment(task_id)}")

    def task_wait(self, task_id: str, timeout_seconds: int = 30) -> dict[str, Any]:
        """Poll a task until terminal or until the MCP wait bound expires."""
        if timeout_seconds < 1 or timeout_seconds > 60:
            raise ValueError("timeout_seconds must be between 1 and 60")

        deadline = time.monotonic() + timeout_seconds
        task = self.task_get(task_id)
        while task.get("status") not in TERMINAL_TASK_STATUSES:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(0.25, remaining))
            task = self.task_get(task_id)
        return task

    def task_cancel(self, task_id: str) -> dict[str, Any]:
        return self._post(f"/v1/tasks/{self._path_segment(task_id)}/cancel")

    # ------------------------------------------------------------------
    # Plugin convenience
    # ------------------------------------------------------------------

    def plugin_call(
        self,
        worker: str,
        plugin_id: str,
        tool_name: str,
        arguments: dict[str, Any],
        timeout_seconds: int = 120,
    ) -> dict[str, Any]:
        if timeout_seconds < 1 or timeout_seconds > 3600:
            raise ValueError("timeout_seconds must be between 1 and 3600")
        return self._dispatch_task(
            self._resolve_worker_id(worker),
            "plugin_call",
            {"plugin_id": plugin_id, "tool_name": tool_name, "arguments": arguments},
            timeout_seconds=timeout_seconds,
            wait=True,
        )


def _json_object(raw: str, option: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{option} must contain valid JSON") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{option} must contain a JSON object")
    return value


def _print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def _build_cli_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Call the CapOwn Master REST API")
    parser.add_argument(
        "--config",
        type=Path,
        help=f"client TOML path (default: {DEFAULT_CONFIG_PATH})",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("health", help="check the versioned Master health endpoint")
    commands.add_parser("meta", help="show Master metadata")
    commands.add_parser(
        "workers-list",
        help="list Workers visible to this token",
    )

    worker = commands.add_parser("worker-get", help="show one Worker")
    worker.add_argument("worker")

    plugins = commands.add_parser("plugin-list", help="list one Worker's plugins")
    plugins.add_argument("worker")

    task = commands.add_parser("task-get", help="show one task")
    task.add_argument("task_id")

    wait = commands.add_parser("task-wait", help="wait for one task")
    wait.add_argument("task_id")
    wait.add_argument("--timeout-seconds", type=int, default=30)

    cancel = commands.add_parser("task-cancel", help="cancel one task")
    cancel.add_argument("task_id")

    plugin_call = commands.add_parser("plugin-call", help="invoke a Worker plugin tool")
    plugin_call.add_argument("--worker", required=True)
    plugin_call.add_argument("--plugin-id", required=True)
    plugin_call.add_argument("--tool-name", required=True)
    plugin_call.add_argument("--arguments", default="{}", help="tool arguments as a JSON object")
    plugin_call.add_argument("--timeout-seconds", type=int, default=120)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_cli_parser().parse_args(argv)
    try:
        client = CapownClient(ClientConfig.from_file(args.config))
        if args.command == "health":
            result = client.health()
        elif args.command == "meta":
            result = client.meta()
        elif args.command == "workers-list":
            result = client.workers_list()
        elif args.command == "worker-get":
            result = client.worker_get(args.worker)
        elif args.command == "plugin-list":
            result = client.plugin_list(args.worker)
        elif args.command == "task-get":
            result = client.task_get(args.task_id)
        elif args.command == "task-wait":
            result = client.task_wait(args.task_id, args.timeout_seconds)
        elif args.command == "task-cancel":
            result = client.task_cancel(args.task_id)
        elif args.command == "plugin-call":
            result = client.plugin_call(
                args.worker,
                args.plugin_id,
                args.tool_name,
                _json_object(args.arguments, "--arguments"),
                timeout_seconds=args.timeout_seconds,
            )
        else:
            raise ValueError(f"unsupported command: {args.command}")
    except (ApiError, OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    _print_json(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
