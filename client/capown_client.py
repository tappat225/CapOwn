# SPDX-License-Identifier: Apache-2.0
"""Minimal CapOwn Next REST Client -- task and plugin operations.

Standard-library only (urllib). Targets the v1.4 protocol.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ClientConfig:
    master_url: str = "http://localhost:9230"
    client_token: str = ""
    request_timeout: int = 30


@dataclass
class ApiError(Exception):
    code: str
    message: str
    details: Any = None
    status: int = 0

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"


class CapownClient:
    """HTTP client for the CapOwn Next Master v1 API."""

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

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.config.client_token:
            headers["Authorization"] = f"Bearer {self.config.client_token}"
        return headers

    def _request(
        self,
        method: str,
        path: str,
        body: Any = None,
        params: dict[str, str] | None = None,
    ) -> Any:
        url = self._build_url(path)
        if params:
            qs = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
            url += "?" + qs

        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            url,
            data=data,
            headers=self._headers(),
            method=method,
        )

        try:
            with urllib.request.urlopen(req, timeout=self.config.request_timeout) as resp:
                raw = resp.read().decode("utf-8")
                if raw:
                    return json.loads(raw)
                return None
        except urllib.error.HTTPError as exc:
            status = exc.code
            try:
                err_body = json.loads(exc.read().decode("utf-8"))
                if isinstance(err_body, dict) and "error" in err_body:
                    err = err_body["error"]
                    raise ApiError(
                        code=err.get("code", "http_error"),
                        message=err.get("message", str(exc)),
                        details=err.get("details"),
                        status=status,
                    ) from exc
            except (json.JSONDecodeError, TypeError):
                pass
            raise ApiError(
                code="http_error",
                message=f"HTTP {status}: {exc.reason}",
                status=status,
            ) from exc
        except urllib.error.URLError as exc:
            raise ApiError(
                code="connection_error",
                message=str(exc.reason),
            ) from exc

    def _get(self, path: str) -> Any:
        return self._request("GET", path)

    def _post(self, path: str, body: Any = None, params: dict[str, str] | None = None) -> Any:
        return self._request("POST", path, body, params)

    def _put(self, path: str, body: Any = None) -> Any:
        return self._request("PUT", path, body)

    def _delete(self, path: str) -> None:
        self._request("DELETE", path)

    # ------------------------------------------------------------------
    # Worker operations
    # ------------------------------------------------------------------

    def list_workers(self) -> list[dict[str, Any]]:
        data = self._get("/v1/workers")
        if isinstance(data, dict):
            return data.get("items", [])
        return data or []

    def get_worker(self, worker_id: str) -> dict[str, Any]:
        return self._get(f"/v1/workers/{worker_id}")

    def get_worker_plugins(self, worker_id: str) -> list[dict[str, Any]]:
        return self._get(f"/v1/workers/{worker_id}/plugins")

    # ------------------------------------------------------------------
    # Task operations
    # ------------------------------------------------------------------

    def dispatch_task(
        self,
        worker_id: str,
        task_type: str,
        params: dict[str, Any],
        timeout_seconds: int = 120,
        wait: bool = False,
    ) -> dict[str, Any]:
        qparams = {"wait": "true"} if wait else None
        return self._post(
            "/v1/tasks",
            {
                "target_worker": worker_id,
                "payload": {"task_type": task_type, "params": params},
                "timeout_seconds": timeout_seconds,
            },
            params=qparams,
        )

    def get_task(self, task_id: str) -> dict[str, Any]:
        return self._get(f"/v1/tasks/{task_id}")

    def cancel_task(self, task_id: str) -> dict[str, Any]:
        return self._post(f"/v1/tasks/{task_id}/cancel")

    # ------------------------------------------------------------------
    # Plugin convenience
    # ------------------------------------------------------------------

    def plugin_call(
        self,
        worker_id: str,
        plugin_id: str,
        tool_name: str,
        arguments: dict[str, Any],
        timeout_seconds: int = 60,
    ) -> dict[str, Any]:
        return self.dispatch_task(
            worker_id,
            "plugin_call",
            {"plugin_id": plugin_id, "tool_name": tool_name, "arguments": arguments},
            timeout_seconds=timeout_seconds,
            wait=True,
        )
