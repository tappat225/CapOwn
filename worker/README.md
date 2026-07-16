# Worker Next -- Experimental TypeScript Worker for CapOwn

<!-- SPDX-License-Identifier: Apache-2.0 -->

> **This is a connectivity-only milestone.** Worker Next can join the CapOwn
> control plane (enroll, authenticate, maintain an SSE connection) but does
> **not** execute tasks or implement any file/shell/container capabilities.

## Status

- [x] Project skeleton: CLI, logging, signal handling
- [x] Configuration: TOML loading, env overrides, Zod validation
- [x] Identity: Ed25519 keys, PyNaCl-compatible signing, identity.toml
- [x] Master client: enroll, challenge-response auth, runtime PUT
- [x] SSE parser and reconnecting client
- [x] Cross-language signature verification (Node <-> PyNaCl)
- [x] Master `None` vs `[]` capability fix

## Usage

```bash
cd worker
npm ci
npm run typecheck
npm test
npm run build
npm start -- daemon --config path/to/config.toml
npm start -- status
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

## Architecture

```
src/
  cli.ts            CLI entry point
  logging.ts        Structured ASCII logging
  config.ts         Configuration loading and validation
  identity.ts       Ed25519 key management
  platform.ts       Hostname and OS detection
  protocol.ts       TypeScript types for Master v1 API
  master-client.ts  HTTP client for Master endpoints
  sse.ts            SSE parser and reconnecting client
  daemon.ts         Main lifecycle loop
```

## Design Decisions

1. **No task execution in this milestone** -- Worker Next only joins the
   control plane. Task execution, backends, tools, and containers are out of
   scope.
2. **Reports `mode: "capability"` and `capabilities: []`** -- The Master
   fix distinguishes `None` (legacy defaults) from an explicit empty list.
3. **Ed25519 keys via Node `crypto`** -- Raw 32-byte seed format matches
   PyNaCl for cross-language compatibility.
4. **Minimal dependencies** -- Only `toml` (parser) and `zod` (validation).
   Everything else (fetch, crypto, os, fs/promises, node:test) is built-in.

## Testing

```bash
# Unit tests (Node test runner)
npm test

# Cross-language signature verification
uv run python scripts/verify-python-signature.py

# Existing Python regression tests (must pass)
uv run python tests/unit/test_registry.py
```
