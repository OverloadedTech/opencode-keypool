# Contributing to opencode-keypool

Thanks for your interest in contributing.

## Getting started

```bash
git clone https://github.com/<your-fork>/opencode-keypool
cd opencode-keypool
bun install
bun run typecheck
bun test
```

## Conventions

- Runtime must stay dependency-free. The project targets the Bun runtime and
  uses only its standard library, so it loads fast inside opencode's plugin
  runtime and never conflicts with opencode's own dependencies.
- All user-facing strings in the TUI and CLI are plain text without emojis.
- New adapters live in `src/adapters/` and implement the `Adapter` interface
  from `src/adapters/types.ts`: build a request from an OpenAI-style
  chat completion body, and translate the upstream response back to the
  OpenAI wire format.
- Configuration schema changes must stay backwards-compatible: add optional
  fields with defaults in `src/config.ts`.

## Tests

Tests run real HTTP servers in-process (`Bun.serve`) so rotation, failover,
and translation are exercised end-to-end without mocks.

```bash
bun test
```

## Commit style

Use conventional commit messages: `feat(engine): ...`, `fix(tui): ...`.
