# Worker Next -- Experimental TypeScript Worker for CapOwn

<!-- SPDX-License-Identifier: Apache-2.0 -->

> Worker Next implements the current `/v1` Worker contract: registration,
> authentication, runtime heartbeats, and claim-based job execution. It does
> not implement file, shell, or container capabilities.

The Worker/Master wire contract is defined centrally in
[`../protocol/openapi.yaml`](../protocol/openapi.yaml). The TypeScript types in
`src/protocol.ts` are an implementation view of that contract.

## Status

- [x] Project skeleton: CLI, logging, signal handling
- [x] Configuration: TOML loading, env overrides, Zod validation
- [x] Identity: Ed25519 keys, PyNaCl-compatible signing, identity.toml
- [x] Master client: register, challenge-response auth, runtime PUT, job claim,
  and task result reporting
- [x] Claim-based task execution and cancellation
- [x] Periodic runtime heartbeat with reconnect
- [x] Cross-language signature verification (Node <-> PyNaCl)
- [x] Installation script: `install-worker.sh` / `install-worker.ps1`
- [x] Registration flow: `capown-worker register <link>`

## Usage

```bash
cd worker
npm ci
npm run typecheck
npm test
npm run build

# Install to ~/.capown (optional)
bash ../scripts/install-worker.sh
# or on Windows:
# ..\scripts\install-worker.ps1

# Register with a Master
capown-worker register https://master.example.com/v1/worker-registrations/<token>

# Start daemon
capown-worker daemon

# Check status
capown-worker status

# Show config
capown-worker config show
```

### Configuration

See `config.toml.example`. Resolution order:

1. `--config <path>` flag
2. `CAPOWN_WORKER_NEXT_CONFIG` env
3. `CAPOWN_WORKER_CONFIG` env
4. `CAPOWN_CONFIG` env
5. `~/.capown/worker/config.toml`

### Identity

Worker Next reuses the existing `~/.capown/worker/identity.toml` format.
Ed25519 keys are generated using Node's `crypto` module and are fully
interoperable with PyNaCl. Use `--identity <path>` or `CAPOWN_WORKER_IDENTITY`
for isolated testing.

The `register` command saves the `worker_id` and `worker_name` to the identity
file after a successful registration. The daemon then only needs the identity
to authenticate; no registration token is persisted.

## Architecture

```
src/
  cli.ts            CLI entry point
  logging.ts        Structured ASCII logging
  config.ts         Configuration loading and validation
  identity.ts       Ed25519 key management
  platform.ts       Hostname and OS detection
  protocol.ts       TypeScript types for the current Master API protocol
  master-client.ts  HTTP client for Master endpoints
  daemon.ts         Main lifecycle and job claim loop
```

## Design Decisions

1. **Claim is authoritative** -- Jobs are received through
   `POST /v1/workers/{worker_id}/jobs/claim`. The Worker confirms a task with
   `status: running` and the current `delivery_id` before invoking its plugin.
   The claim loop continues while tasks execute so cancellation remains
   responsive.
2. **Reports `mode: "capability"` and `capabilities: []`** -- Plugin metadata
   is reported separately and execution is selected by claimed job type.
3. **Ed25519 keys via Node `crypto`** -- Raw 32-byte seed format matches
   PyNaCl for cross-language compatibility.
4. **Minimal dependencies** -- Only `toml` (parser) and `zod` (validation).
   Everything else (fetch, crypto, os, fs/promises, node:test) is built-in.
5. **Registration token is never persisted** -- The `register` command uses
   the registration token once and discards it. The daemon authenticates
   solely via Ed25519 challenge-response using the worker identity.

## Testing

```bash
# Unit tests (Node test runner)
npm test

# Cross-language signature verification
uv run python scripts/verify-python-signature.py
```
