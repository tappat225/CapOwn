# SPDX-License-Identifier: Apache-2.0
"""Fake MCP stdio plugin server for E2E testing.

Provides tools: echo, structured_echo, sleep, fail
"""

from __future__ import annotations

import json
import sys
import time
from typing import Any


def read_request() -> dict[str, Any] | None:
    line = sys.stdin.readline()
    if not line:
        return None
    return json.loads(line)


def send_response(req_id: int, result: Any = None, error: Any = None) -> None:
    msg: dict[str, Any] = {"jsonrpc": "2.0", "id": req_id}
    if error:
        msg["error"] = error
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def handle_initialize(req_id: int, params: dict[str, Any]) -> None:
    send_response(req_id, {
        "protocolVersion": "2025-03-26",
        "capabilities": {"tools": {}},
        "serverInfo": {"name": "fake-mcp-test", "version": "1.0.0"},
    })


def handle_tools_list(req_id: int) -> None:
    send_response(req_id, {
        "tools": [
            {
                "name": "echo",
                "description": "Echo back the input text",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "text": {"type": "string", "description": "Text to echo"},
                    },
                    "required": ["text"],
                },
            },
            {
                "name": "structured_echo",
                "description": "Echo back structured data",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "value": {"type": "object", "description": "Data to echo"},
                    },
                    "required": ["value"],
                },
            },
            {
                "name": "sleep",
                "description": "Sleep for N seconds (for timeout testing)",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "seconds": {"type": "number", "description": "Seconds to sleep"},
                    },
                    "required": ["seconds"],
                },
            },
            {
                "name": "fail",
                "description": "Always fails with an error",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "message": {"type": "string", "description": "Error message"},
                    },
                },
            },
        ],
    })


def handle_tools_call(req_id: int, params: dict[str, Any]) -> None:
    name = params.get("name", "")
    arguments = params.get("arguments", {})

    if name == "echo":
        text = arguments.get("text", "")
        send_response(req_id, {
            "content": [{"type": "text", "text": text}],
            "isError": False,
        })

    elif name == "structured_echo":
        value = arguments.get("value", {})
        send_response(req_id, {
            "content": [{"type": "text", "text": json.dumps(value)}],
            "isError": False,
        })

    elif name == "sleep":
        seconds = arguments.get("seconds", 1)
        time.sleep(seconds)
        send_response(req_id, {
            "content": [{"type": "text", "text": f"slept for {seconds}s"}],
            "isError": False,
        })

    elif name == "fail":
        message = arguments.get("message", "intentional failure")
        send_response(req_id, {
            "content": [{"type": "text", "text": message}],
            "isError": True,
        })

    else:
        send_response(req_id, None, {
            "code": -32601,
            "message": f"Tool not found: {name}",
        })


def main() -> None:
    while True:
        req = read_request()
        if req is None:
            break

        req_id = req.get("id", 0)
        method = req.get("method", "")
        params = req.get("params", {})

        if method == "initialize":
            handle_initialize(req_id, params)
        elif method == "tools/list":
            handle_tools_list(req_id)
        elif method == "tools/call":
            handle_tools_call(req_id, params)
        else:
            send_response(req_id, None, {
                "code": -32601,
                "message": f"Method not found: {method}",
            })


if __name__ == "__main__":
    main()
