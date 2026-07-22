#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Uninstall CapOwn components installed below ``~/.capown``.

The normal uninstall removes installed programs and launchers while keeping
component data.  ``--force`` removes the selected component's data as well.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence


COMPONENTS = ("worker", "master", "client")
DEFAULT_CAPOWN_DIR = ".capown"
WORKER_LAUNCHERS = ("capown-worker", "run_worker")
MASTER_LAUNCHERS = ("capown-master",)
CLIENT_LAUNCHERS = ("capown",)
LAUNCHER_SUFFIXES = ("", ".cmd", ".sh", ".ps1")


@dataclass(frozen=True)
class ProcessInfo:
    """A process identified without exposing its command line to output."""

    pid: int
    name: str
    command: str


@dataclass(frozen=True)
class ContainerInfo:
    name: str


@dataclass(frozen=True)
class ComponentSpec:
    name: str
    launchers: tuple[str, ...]


SPECS = {
    "worker": ComponentSpec("worker", WORKER_LAUNCHERS),
    "master": ComponentSpec("master", MASTER_LAUNCHERS),
    "client": ComponentSpec("client", CLIENT_LAUNCHERS),
}


def capown_dir() -> Path:
    return Path.home() / DEFAULT_CAPOWN_DIR


def component_dir(component: str) -> Path:
    return capown_dir() / component


def _path_exists(path: Path) -> bool:
    return path.exists() or path.is_symlink()


def _path_inside_capown(path: Path) -> bool:
    """Guard recursive deletion against an accidentally broad target."""
    root = capown_dir().resolve()
    target = path.resolve(strict=False)
    try:
        target.relative_to(root)
    except ValueError:
        return False
    return True


def _remove_path(path: Path, description: str) -> bool:
    if not _path_exists(path):
        return True
    if not _path_inside_capown(path):
        print(f"  [FAILED] refusing to remove path outside {capown_dir()}: {path}")
        return False
    try:
        if path.is_symlink() or not path.is_dir():
            path.unlink()
        else:
            shutil.rmtree(path)
    except OSError as exc:
        print(f"  [FAILED] {description}: {path} ({exc})")
        return False
    print(f"  [DELETED] {description}: {path}")
    return True


def _remove_empty_dir(path: Path, description: str) -> None:
    if not path.is_dir() or path.is_symlink():
        return
    try:
        path.rmdir()
    except OSError:
        return
    print(f"  [DELETED] empty {description}: {path}")


def _normalise_text(value: str) -> str:
    return value.replace("\\", "/").casefold()


def _text_contains_path(text: str, path: Path) -> bool:
    return _normalise_text(str(path.resolve(strict=False))) in _normalise_text(text)


def _iter_proc_processes() -> Iterable[ProcessInfo]:
    proc_dir = Path("/proc")
    if not proc_dir.is_dir():
        return
    for entry in proc_dir.iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid == os.getpid():
            continue
        try:
            raw_command = (entry / "cmdline").read_bytes()
            command = raw_command.replace(b"\x00", b" ").decode(
                "utf-8", errors="replace"
            ).strip()
            executable = os.readlink(entry / "exe")
        except (OSError, UnicodeError):
            continue
        name = Path(executable).name or command.split(" ", 1)[0]
        yield ProcessInfo(pid, name, command)


def _windows_processes() -> Iterable[ProcessInfo]:
    powershell = shutil.which("powershell") or shutil.which("pwsh")
    if not powershell:
        return
    query = (
        "$ErrorActionPreference='SilentlyContinue'; "
        "Get-CimInstance Win32_Process | "
        "Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"
    )
    try:
        result = subprocess.run(
            [powershell, "-NoProfile", "-NonInteractive", "-Command", query],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return
        rows = json.loads(result.stdout)
        if isinstance(rows, dict):
            rows = [rows]
        for row in rows:
            if not isinstance(row, dict):
                continue
            try:
                pid = int(row["ProcessId"])
            except (KeyError, TypeError, ValueError):
                continue
            if pid == os.getpid():
                continue
            yield ProcessInfo(
                pid,
                str(row.get("Name") or ""),
                str(row.get("CommandLine") or ""),
            )
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return


def _ps_processes() -> Iterable[ProcessInfo]:
    try:
        result = subprocess.run(
            ["ps", "-axo", "pid=,comm=,args="],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 2)
        if len(fields) < 2:
            continue
        try:
            pid = int(fields[0])
        except ValueError:
            continue
        if pid == os.getpid():
            continue
        name = fields[1]
        command = fields[2] if len(fields) == 3 else name
        yield ProcessInfo(pid, name, command)


def _iter_processes() -> Iterable[ProcessInfo]:
    if sys.platform == "win32":
        yield from _windows_processes()
    elif Path("/proc").is_dir():
        yield from _iter_proc_processes()
    else:
        yield from _ps_processes()


def _process_matches(component: str, process: ProcessInfo) -> bool:
    command = _normalise_text(process.command)
    name = _normalise_text(process.name)
    identity = f"{name} {command}"
    root = component_dir(component)

    if component == "worker":
        return (
            "capown-worker" in identity
            or (
                _text_contains_path(process.command, root)
                and ("cli.js" in command or "worker" in name)
            )
        )
    if component == "master":
        return "capown-master" in identity or _text_contains_path(process.command, root)
    if component == "client":
        if _text_contains_path(process.command, root):
            return True
        return bool(re.search(r"(?:^|[\s\"'])capown(?:\.exe|\.cmd)?(?:$|[\s\"'])", process.command, re.I))
    return False


def _find_processes(component: str) -> list[ProcessInfo]:
    found: dict[int, ProcessInfo] = {}
    for process in _iter_processes():
        if process.pid > 0 and _process_matches(component, process):
            found[process.pid] = process
    return sorted(found.values(), key=lambda item: item.pid)


def _docker_containers() -> list[ContainerInfo]:
    docker = shutil.which("docker")
    if not docker:
        return []
    format_string = "{{.ID}}\t{{.Names}}\t{{.Label \"com.docker.compose.project\"}}"
    try:
        result = subprocess.run(
            [docker, "ps", "-a", "--format", format_string],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    containers: list[ContainerInfo] = []
    for line in result.stdout.splitlines():
        fields = line.split("\t")
        if len(fields) < 2:
            continue
        name = fields[1].strip()
        project = fields[2].strip() if len(fields) > 2 else ""
        if project == "capown-master" or name == "capown-master" or name.startswith("capown-master-"):
            containers.append(ContainerInfo(name))
    return containers


def _read_worker_runtime_state() -> dict[str, object] | None:
    state_path = component_dir("worker") / "worker-runtime.json"
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(state, dict):
        return None
    try:
        pid = int(state["pid"])
        port = int(state["port"])
        token = state["control_token"]
    except (KeyError, TypeError, ValueError):
        return None
    if pid <= 0 or not 1 <= port <= 65535 or not isinstance(token, str) or not token:
        return None
    return {"pid": pid, "port": port, "token": token}


def _worker_stop_request(state: dict[str, object]) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", int(state["port"])), timeout=1.0) as conn:
            request = {"token": state["token"], "command": "stop"}
            conn.sendall((json.dumps(request) + "\n").encode("utf-8"))
            response = b""
            while b"\n" not in response and len(response) < 16 * 1024:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                response += chunk
            parsed = json.loads(response.split(b"\n", 1)[0].decode("utf-8"))
            return isinstance(parsed, dict) and parsed.get("ok") is True
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return False


def _pid_is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _wait_for_exit(pids: Sequence[int], timeout: float = 5.0) -> list[int]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        remaining = [pid for pid in pids if _pid_is_alive(pid)]
        if not remaining:
            return []
        time.sleep(0.1)
    return [pid for pid in pids if _pid_is_alive(pid)]


def _terminate_pid(pid: int) -> None:
    if not _pid_is_alive(pid):
        return
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T"],
            capture_output=True,
            text=True,
            check=False,
        )
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        return


def _force_terminate_pid(pid: int) -> None:
    if not _pid_is_alive(pid):
        return
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            capture_output=True,
            text=True,
            check=False,
        )
        return
    try:
        os.kill(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        return


def _stop_processes(component: str, processes: Sequence[ProcessInfo]) -> bool:
    if not processes:
        return True
    pids = [process.pid for process in processes]
    for pid in pids:
        _terminate_pid(pid)
    remaining = _wait_for_exit(pids)
    if remaining:
        print(f"  warning: process(es) did not stop gracefully: {', '.join(map(str, remaining))}")
        for pid in remaining:
            _force_terminate_pid(pid)
        remaining = _wait_for_exit(remaining, timeout=2.0)
    if remaining:
        print(f"  [FAILED] could not stop {component} process(es): {', '.join(map(str, remaining))}")
        return False
    print(f"  [STOPPED] {component} process(es): {', '.join(map(str, pids))}")
    return True


def _stop_worker(component_processes: Sequence[ProcessInfo]) -> bool:
    state = _read_worker_runtime_state()
    state_pid = int(state["pid"]) if state is not None else None
    if state_pid is not None and _pid_is_alive(state_pid):
        if _worker_stop_request(state):
            remaining = _wait_for_exit([state_pid])
            if not remaining:
                print(f"  [STOPPED] Worker runtime (PID {state['pid']})")
            else:
                print(f"  warning: Worker control request did not stop PID {state['pid']}")
        else:
            print("  warning: Worker control request failed; using process termination")
        if _pid_is_alive(state_pid) and all(
            process.pid != state_pid for process in component_processes
        ):
            print(f"  [FAILED] Worker runtime PID {state_pid} could not be identified safely")
            return False
    return _stop_processes("worker", component_processes)


def _stop_containers(containers: Sequence[ContainerInfo]) -> bool:
    if not containers:
        return True
    docker = shutil.which("docker")
    if not docker:
        print("  [FAILED] Docker containers found but the Docker CLI is unavailable")
        return False
    success = True
    for container in containers:
        try:
            stopped = subprocess.run(
                [docker, "stop", container.name],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            print(f"  warning: could not stop Docker container: {container.name}")
            success = False
            continue
        if stopped.returncode != 0:
            print(f"  warning: could not stop Docker container: {container.name}")
            success = False
            continue
        try:
            removed = subprocess.run(
                [docker, "rm", container.name],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            print(f"  [FAILED] could not remove Docker container: {container.name}")
            success = False
            continue
        if removed.returncode != 0:
            print(f"  [FAILED] could not remove Docker container: {container.name}")
            success = False
        else:
            print(f"  [DELETED] Docker container: {container.name}")
    return success


def _stop_component(component: str, processes: Sequence[ProcessInfo], containers: Sequence[ContainerInfo]) -> bool:
    if component == "worker":
        return _stop_worker(processes)
    process_ok = _stop_processes(component, processes)
    container_ok = _stop_containers(containers)
    return process_ok and container_ok


def _program_paths(component: str) -> list[Path]:
    root = component_dir(component)
    if component == "master":
        return [
            root / "capown-master",
            root / "capown-master.exe",
            root / "app",
            root / "venv",
        ]
    if component == "worker":
        paths = [root / "app", root / "venv", root / "plugins"]
        paths.extend(root.glob(".app-install-*"))
        paths.extend(root.glob(".app-install.*"))
        return paths
    return [root / "app", root / "venv"]


def _runtime_paths(component: str) -> list[Path]:
    if component != "worker":
        return []
    root = component_dir(component)
    return [root / "worker-runtime.json", root / "worker-runtime.lock"]


def _launcher_paths(component: str) -> list[Path]:
    bin_dir = capown_dir() / "bin"
    paths: list[Path] = []
    for name in SPECS[component].launchers:
        paths.extend(bin_dir / f"{name}{suffix}" for suffix in LAUNCHER_SUFFIXES)
    return paths


def _remove_launcher_links(component: str) -> None:
    local_bin = Path.home() / ".local" / "bin"
    if not local_bin.is_dir():
        return
    launcher_targets = {
        path.resolve(strict=False) for path in _launcher_paths(component)
    }
    names = {path.name for path in _launcher_paths(component)}
    for entry in local_bin.iterdir():
        if entry.name not in names or not entry.is_symlink():
            continue
        try:
            if entry.resolve(strict=False) in launcher_targets:
                entry.unlink()
                print(f"  [DELETED] launcher link: {entry}")
        except OSError as exc:
            print(f"  [FAILED] launcher link: {entry} ({exc})")


def _remove_programs(component: str) -> bool:
    success = True
    for path in _runtime_paths(component) + _program_paths(component):
        success = _remove_path(path, f"{component} program/runtime") and success
    for path in _launcher_paths(component):
        success = _remove_path(path, f"{component} launcher") and success
    _remove_launcher_links(component)
    _remove_empty_dir(capown_dir() / "bin", "launcher directory")
    return success


def _purge_component_data(component: str) -> bool:
    success = _remove_path(component_dir(component), f"{component} data")
    if component == "worker":
        # Older classic installs kept the Worker workspace at this path.
        success = _remove_path(capown_dir() / "workspace", "legacy Worker workspace") and success
    return success


def _remove_shared_programs(components: Sequence[str]) -> bool:
    if set(components) != set(COMPONENTS):
        return True
    return _remove_path(capown_dir() / "tools", "shared CapOwn tools")


def _has_component_artifacts(component: str) -> bool:
    if _path_exists(component_dir(component)):
        return True
    if any(_path_exists(path) for path in _launcher_paths(component)):
        return True
    if _find_processes(component):
        return True
    return component == "master" and bool(_docker_containers())


def _ask_yes_no(prompt: str, default: bool) -> bool:
    suffix = "[Y/n]" if default else "[y/N]"
    try:
        answer = input(f"{prompt} {suffix} ").strip().casefold()
    except (EOFError, KeyboardInterrupt):
        print()
        return False
    if not answer:
        return default
    if answer in {"y", "yes"}:
        return True
    if answer in {"n", "no"}:
        return False
    print("Please answer yes or no.")
    return _ask_yes_no(prompt, default)


def _collect_targets(components: Sequence[str]) -> dict[str, tuple[list[ProcessInfo], list[ContainerInfo]]]:
    targets: dict[str, tuple[list[ProcessInfo], list[ContainerInfo]]] = {}
    for component in components:
        containers = _docker_containers() if component == "master" else []
        targets[component] = (_find_processes(component), containers)
    return targets


def _print_help(parser: argparse.ArgumentParser) -> None:
    parser.print_help()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Uninstall CapOwn Worker, Master, or Client. "
            "Dashboard is managed separately."
        ),
        usage="python3 scripts/uninstall.py [--all | worker | master | client] [--yes | --force]",
    )
    parser.add_argument(
        "component",
        nargs="?",
        choices=COMPONENTS,
        help="component to uninstall (omit the component and --all to print help)",
    )
    target_group = parser.add_mutually_exclusive_group()
    target_group.add_argument(
        "--all",
        action="store_true",
        help="uninstall Worker, Master, and Client; Dashboard is excluded",
    )
    data_group = parser.add_mutually_exclusive_group()
    data_group.add_argument(
        "--yes",
        action="store_true",
        help="stop automatically and keep all component data",
    )
    data_group.add_argument(
        "--force",
        action="store_true",
        help="stop automatically and remove all selected component data",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.all and args.component:
        parser.error("--all cannot be combined with a component name")
    if not args.all and not args.component:
        _print_help(parser)
        return 0

    components = list(COMPONENTS if args.all else (args.component,))
    targets = _collect_targets(components)
    installed = [component for component in components if _has_component_artifacts(component)]
    if args.all and _path_exists(capown_dir() / "tools"):
        installed = components
    if not installed:
        print("No selected CapOwn component is installed.")
        return 0

    print(f"CapOwn root: {capown_dir()}")
    print("Selected components: " + ", ".join(components))
    if args.force:
        keep_data = False
        print("Mode: force; component programs and data will be removed.")
    elif args.yes:
        keep_data = True
        print("Mode: yes; component programs will be removed and data will be kept.")
    else:
        running = [
            component
            for component, (processes, containers) in targets.items()
            if processes or containers
        ]
        if running:
            print("Running CapOwn components detected: " + ", ".join(running))
            if not _ask_yes_no("Stop them and continue with uninstall?", True):
                print("Cancelled.")
                return 0
        keep_data = _ask_yes_no(
            "Keep all selected component configuration and data?", True
        )

    success = True
    for component in installed:
        processes, containers = targets[component]
        if not _stop_component(component, processes, containers):
            success = False
            print(f"Skipping file removal for {component} because it is still running.")
            continue
        if not _remove_programs(component):
            success = False
            continue
        if not keep_data and not _purge_component_data(component):
            success = False

    success = _remove_shared_programs(components) and success

    if success:
        print("Uninstall completed.")
        return 0
    print("Uninstall completed with errors.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
