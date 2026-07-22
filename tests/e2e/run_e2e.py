# SPDX-License-Identifier: Apache-2.0
"""CapOwn E2E test — Master + Worker + fake MCP plugin.

Usage:
    python tests/e2e/run_e2e.py

Requires:
    - Go Master binary at master/capown-master[.exe]
    - Node Worker built (`cd worker; npm run build`)
    - Python 3.10+ with standard library only (no extra deps)
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
CLIENT_DIR = REPO_ROOT / "client"
FIXTURE_DIR = REPO_ROOT / "tests" / "fixtures"
MASTER_DIR = REPO_ROOT / "master"
WORKER_DIR = REPO_ROOT / "worker"
PLUGIN_SERVER = FIXTURE_DIR / "fake-mcp-plugin" / "server.py"
MASTER_BINARY = MASTER_DIR / ("capown-master.exe" if os.name == "nt" else "capown-master")


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for_health(url: str, timeout: float = 10.0) -> bool:
    import urllib.error
    import urllib.request
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            resp = urllib.request.urlopen(url, timeout=2)
            if resp.status == 200:
                return True
        except (urllib.error.URLError, ConnectionError, OSError):
            pass
        time.sleep(0.3)
    return False


def generate_ed25519_keypair() -> dict[str, str]:
    """Generate Ed25519 keypair using Node.js crypto (raw 32-byte format)."""
    script = """
    const crypto = require('crypto');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const privDer = privateKey.export({ format: 'der', type: 'pkcs8' });
    const pubDer = publicKey.export({ format: 'der', type: 'spki' });
    console.log(JSON.stringify({
        privateKeyHex: Buffer.from(privDer.subarray(-32)).toString('hex'),
        publicKeyHex: Buffer.from(pubDer.subarray(-32)).toString('hex'),
    }));
    """
    result = subprocess.run(
        ["node", "-e", script],
        capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout.strip())


def safe_output(data: bytes, limit: int = 2000) -> str:
    return data.decode("utf-8", errors="backslashreplace")[-limit:].encode(
        "ascii", errors="backslashreplace"
    ).decode("ascii")


def main() -> int:
    port = find_free_port()
    master_url = f"http://127.0.0.1:{port}"

    tmpdir = tempfile.mkdtemp(prefix="capown-e2e-")
    db_path = os.path.join(tmpdir, "test.db")
    identity_dir = os.path.join(tmpdir, "identity")
    config_dir = os.path.join(tmpdir, "config")
    os.makedirs(identity_dir, exist_ok=True)
    os.makedirs(config_dir, exist_ok=True)

    print(f"[e2e] Using temp dir: {tmpdir}")
    print(f"[e2e] Starting Master on port {port}...")

    master_env = os.environ.copy()
    master_env["CAPOWN_MASTER_DB_PATH"] = db_path
    master_env["CAPOWN_MASTER_HOST"] = "127.0.0.1"
    master_env["CAPOWN_MASTER_PORT"] = str(port)
    # Avoid blocking the subprocess on an unread pipe during polling-heavy tests.
    master_env["CAPOWN_MASTER_LOG_LEVEL"] = "error"

    worker_proc: subprocess.Popen[bytes] | None = None
    master_proc = subprocess.Popen(
        [str(MASTER_BINARY)],
        cwd=MASTER_DIR,
        env=master_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    try:
        if not wait_for_health(f"{master_url}/healthz"):
            stdout, stderr = master_proc.communicate(timeout=5)
            print("[e2e] FAIL: Master did not become healthy")
            print("[e2e] Master stdout:", stdout.decode()[-500:])
            print("[e2e] Master stderr:", stderr.decode()[-500:])
            return 1

        print("[e2e] Master is healthy")

        sys.path.insert(0, str(CLIENT_DIR))
        from capown_client import CapownClient, ClientConfig, ApiError

        client = CapownClient(ClientConfig(master_url=master_url, request_timeout=5))

        # 1. Register first user
        print("[e2e] Step 1: Registering first user...")
        resp = client._post("/v1/auth/register", {"username": "admin", "password": "testpass123"})
        web_token = resp["access_token"]
        print("[e2e] Registered user")

        # 2. Create client token
        print("[e2e] Step 2: Creating client token...")
        client.config.client_token = web_token
        tok_resp = client._post("/v1/tokens", {"type": "client", "label": "e2e-test"})
        client_token = tok_resp["token"]
        print("[e2e] Client token created")
        client.config.client_token = client_token

        # 3. Create worker registration token
        print("[e2e] Step 3: Creating worker registration token...")
        client.config.client_token = web_token
        reg_resp = client._post("/v1/worker-registrations", {
            "label": "e2e-worker",
            "max_uses": 1,
        })
        registration_token = reg_resp["registration_token"]
        print("[e2e] Registration token created")
        client.config.client_token = client_token

        # 4. Generate Ed25519 keypair
        print("[e2e] Step 4: Generating worker Ed25519 keypair...")
        keys = generate_ed25519_keypair()
        pub_hex = keys["publicKeyHex"]
        priv_hex = keys["privateKeyHex"]

        worker_name = f"e2e-worker-{uuid.uuid4().hex[:6]}"

        # 5. Register worker
        print("[e2e] Step 5: Registering worker...")
        wr = client._post("/v1/workers", {
            "registration_token": registration_token,
            "worker_name": worker_name,
            "public_key": pub_hex,
            "hostname": "e2e-test",
            "os": "linux",
            "mode": "capability",
            "capabilities": [],
            "workspace": "/tmp",
        })
        worker_id = wr["worker_id"]
        print(f"[e2e] Worker registered: {worker_id}")

        # 6. Prepare worker configuration
        print("[e2e] Step 6: Preparing worker configuration...")

        # Write identity (flat TOML format)
        identity_path = os.path.join(identity_dir, "identity.toml")
        with open(identity_path, "w") as f:
            f.write(f'private_key = "{priv_hex}"\n')
            f.write(f'public_key = "{pub_hex}"\n')
            f.write(f'worker_id = "{worker_id}"\n')
            f.write(f'worker_name = "{worker_name}"\n')

        # Write worker config
        worker_config_path = os.path.join(config_dir, "config.toml")
        with open(worker_config_path, "w") as f:
            f.write(f'master_url = "{master_url}"\n')
            f.write(f'config_dir = "{config_dir}"\n')

        # Create plugins.d with fake plugin manifest
        plugins_dir = os.path.join(config_dir, "plugins.d")
        os.makedirs(plugins_dir, exist_ok=True)
        manifest = {
            "schema_version": 1,
            "plugin_id": "fake-test",
            "version": "1.0.0",
            "display_name": "Fake Test Plugin",
            "description": "Fake MCP plugin for E2E testing",
            "kind": "mcp",
            "transport": "stdio",
            "enabled": True,
            "command": ["python", str(PLUGIN_SERVER)],
            "limits": {
                "startup_timeout_seconds": 10,
                "call_timeout_seconds": 30,
                "max_output_bytes": 100000,
                "max_concurrency": 4,
            },
        }
        with open(os.path.join(plugins_dir, "fake-test.json"), "w") as f:
            json.dump(manifest, f, indent=2)

        # 7. Start Worker
        print("[e2e] Step 7: Starting Worker...")
        worker_proc = subprocess.Popen(
            ["node", "dist/src/cli.js", "start", "--foreground"],
            cwd=WORKER_DIR,
            env={
                **os.environ,
                "CAPOWN_CONFIG": worker_config_path,
                "CAPOWN_WORKER_IDENTITY": identity_path,
            },
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        # 8. Wait for the Worker runtime report. Registration initially creates
        # an online row, so status alone does not prove the Worker connected.
        print("[e2e] Step 8: Waiting for worker runtime report...")
        worker_online = False
        plugins: list[dict[str, object]] = []
        deadline = time.time() + 20
        while time.time() < deadline:
            try:
                workers = client.workers_list()
                for w in workers:
                    if w["worker_id"] == worker_id and w["status"] == "online":
                        plugins = client.plugin_list(worker_id)
                        worker_online = bool(plugins)
                        break
                if worker_online:
                    break
            except Exception:
                pass
            time.sleep(0.5)

        if not worker_online:
            print("[e2e] FAIL: Worker did not report its runtime within timeout")
            return 1
        print("[e2e] Worker runtime reported")

        # 9. Query plugin list
        print("[e2e] Step 9: Querying plugin list...")
        print(f"[e2e] Plugins reported: {len(plugins)}")

        if not plugins:
            print("[e2e] FAIL: No plugins reported")
            worker_proc.terminate()
            stdout, stderr = worker_proc.communicate(timeout=5)
            print("[e2e] Worker stdout:", stdout.decode(errors="replace")[-1000:])
            print("[e2e] Worker stderr:", stderr.decode(errors="replace")[-1000:])
            worker_proc = None
            return 1

        plugin = plugins[0]
        assert plugin["plugin_id"] == "fake-test", f"Expected fake-test, got {plugin['plugin_id']}"
        assert plugin["status"] == "running", f"Expected running, got {plugin['status']}"
        tool_names = {t["name"] for t in plugin["tools"]}
        assert "echo" in tool_names, f"Expected echo tool, got {tool_names}"
        print("[e2e] Plugin list verified (fake-test running with echo tool)")

        # 10. Test echo plugin call (sync wait)
        print("[e2e] Step 10: Testing echo plugin call...")
        echo_result = client.plugin_call(worker_id, "fake-test", "echo", {"text": "hello e2e"})
        echo_status = echo_result.get("status")
        print(f"[e2e] Echo task status: {echo_status}")

        if echo_status != "completed":
            print(f"[e2e] FAIL: Expected completed, got {echo_status}")
            return 1

        echo_content = echo_result.get("result", {}).get("content", [])
        echo_text = echo_content[0].get("text", "") if echo_content else ""
        assert echo_text == "hello e2e", f"Echo mismatch: {echo_text}"
        print("[e2e] Echo verified: correct text")

        # 11. Test plugin error (fail tool returns isError)
        print("[e2e] Step 11: Testing plugin error handling...")
        fail_result = client.plugin_call(worker_id, "fake-test", "fail", {"message": "test error"})
        fail_status = fail_result.get("status")
        print(f"[e2e] Fail task status: {fail_status}")
        if fail_status != "completed" or not fail_result.get("result", {}).get("is_error"):
            print("[e2e] FAIL: MCP tool error was not preserved in the result")
            return 1

        # 12. Test unknown tool
        print("[e2e] Step 12: Testing unknown tool...")
        unknown_result = client.plugin_call(worker_id, "fake-test", "nonexistent", {})
        unknown_status = unknown_result.get("status")
        unknown_error = unknown_result.get("error", {})
        print(f"[e2e] Unknown tool result: status={unknown_status}, error_code={unknown_error.get('code')}")
        if unknown_status != "failed":
            print(f"[e2e] FAIL: Expected failed status for unknown tool, got {unknown_status}")
            return 1
        print("[e2e] Unknown tool correctly rejected")

        # 13. Test asynchronous timeout
        print("[e2e] Step 13: Testing plugin timeout...")
        timeout_task = client._dispatch_task(
            worker_id, "plugin_call",
            {"plugin_id": "fake-test", "tool_name": "sleep", "arguments": {"seconds": 2}},
            timeout_seconds=1,
        )
        deadline = time.time() + 5
        while time.time() < deadline:
            timeout_task = client.task_get(timeout_task["task_id"])
            if timeout_task.get("status") in {"timeout", "failed", "completed"}:
                break
            time.sleep(0.1)
        if timeout_task.get("status") != "timeout":
            print(f"[e2e] FAIL: Expected timeout, got {timeout_task.get('status')}")
            return 1
        print("[e2e] Timeout verified")

        # 14. Test cancellation remains terminal after the plugin finishes
        print("[e2e] Step 14: Testing task cancellation...")
        cancel_task = client._dispatch_task(
            worker_id, "plugin_call",
            {"plugin_id": "fake-test", "tool_name": "sleep", "arguments": {"seconds": 2}},
            timeout_seconds=5,
        )
        canceled = client.task_cancel(cancel_task["task_id"])
        if canceled.get("status") not in {"running", "canceled"}:
            print(f"[e2e] FAIL: Unexpected cancel response {canceled.get('status')}")
            return 1
        deadline = time.time() + 5
        while time.time() < deadline and canceled.get("status") == "running":
            time.sleep(0.1)
            canceled = client.task_get(cancel_task["task_id"])
        if canceled.get("status") != "canceled":
            print(f"[e2e] FAIL: Expected canceled, got {canceled.get('status')}")
            return 1
        time.sleep(2.5)
        canceled = client.task_get(cancel_task["task_id"])
        if canceled.get("status") != "canceled":
            print(f"[e2e] FAIL: Canceled task was overwritten with {canceled.get('status')}")
            return 1
        print("[e2e] Cancellation verified")

        # 15. Test worker revoke
        print("[e2e] Step 15: Testing worker revoke...")
        client.config.client_token = web_token
        client._delete(f"/v1/workers/{worker_id}")
        print("[e2e] Worker revoked")

        time.sleep(1)
        client.config.client_token = client_token
        try:
            client.plugin_call(worker_id, "fake-test", "echo", {"text": "x"})
            print("[e2e] FAIL: Expected error after revoke")
            return 1
        except ApiError as e:
            print(f"[e2e] Revoke verified: {e.code}")

        print("\n[e2e] All E2E tests passed!")
        return 0

    except Exception:
        if worker_proc is not None:
            worker_proc.terminate()
            stdout, stderr = worker_proc.communicate(timeout=5)
            print("[e2e] Worker stdout:", safe_output(stdout))
            print("[e2e] Worker stderr:", safe_output(stderr))
            worker_proc = None
        master_proc.terminate()
        stdout, stderr = master_proc.communicate(timeout=5)
        print("[e2e] Master stdout:", safe_output(stdout))
        print("[e2e] Master stderr:", safe_output(stderr))
        raise
    finally:
        print("[e2e] Cleaning up...")
        if worker_proc is not None:
            worker_proc.terminate()
            try:
                worker_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                worker_proc.kill()
        if master_proc.poll() is None:
            master_proc.terminate()
            try:
                master_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                master_proc.kill()


if __name__ == "__main__":
    sys.exit(main())
