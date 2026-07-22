# AGENTS.md - CapOwn Dashboard Agent Guide

Operating guide for AI coding assistants working on the Dashboard component in
the CapOwn monorepo. Keep detailed feature specifications in `docs/` and treat
the root protocol document as canonical.

## Quick Commands

```bash
npm run dev       # Start the local development server
npm test          # Run tests
npm run typecheck # TypeScript check
npm run build     # Generate the static out/ directory
node ../scripts/version.mjs check-dashboard # Check Dashboard version metadata
```

## Project Scope

CapOwn Dashboard is a static SPA for operating a CapOwn Master through direct
browser HTTP APIs. It is independently deployable within this repository.
Never import implementation modules from `master/` or `worker/`.

Repository versioning rules are defined in the root
[`VERSIONING.md`](../VERSIONING.md). The committed source is the root
[`version.json`](../version.json); do not add another manual version source.

## Must

- Keep code, comments, logs, and commit messages in English. Program output is
  ASCII-only.
- Keep all Master access and response validation in
  `src/lib/master-client.ts`.
- Store the Master URL only in `localStorage`.
- Store the `cown_web_*` session token only in `sessionStorage`.
- Never log credentials, bearer tokens, or registration tokens.
- Use one login flow for Master discovery, first-user registration, and login.
- Read roles from the connected Master and gate UI features after login.
- Add focused tests for protocol, storage, authentication, and SSE changes.

## Ask First

- Changing role semantics or public route structure.
- Changing Master token storage, exposure, rotation, or download behavior.
- Adding a new browser storage mechanism for Master credentials or tokens.

## Never

- Store Master session tokens in `localStorage` or a server-side database.
- Proxy arbitrary user-submitted URLs or bypass Master role checks.
- Use `EventSource` for authenticated Master SSE; it cannot set an
  `Authorization` header. Use streaming `fetch()` instead.
- Import CapOwn Master or Worker internals.

## Local Patterns

- Browser Master calls -> `src/lib/master-client.ts`.
- Master origin -> `localStorage`; current session -> `sessionStorage`.
- Auth expiry -> clear the browser session and redirect to `/login`.
- Static export -> Next.js `output: "export"`, generated files in `out/`.
