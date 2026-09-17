# Implementer

Transformer: runs **one Task** in an existing workspace. It launches the
Builder, then the Gate sequence it was given (possibly empty), and loops Attempts
until the run is `validated`, `escalated`, or `interrupted`.

Behavioural contract: [SPECS.md](./SPECS.md).

## Stack

Repository stack — TypeScript, Node 24.20, Biome, `node:test`. See [docs/DEVELOPMENT.md](../../../docs/DEVELOPMENT.md).

## Setup

From the repository root:

```bash
nvm use
npm install
```

## Commands

| Task      | Command          |
| --------- | ---------------- |
| Lint      | `npm run lint`   |
| Format    | `npm run format` |
| Typecheck | `npm run tsc`    |
| Test      | `npm test`       |
| Build     | `npm run build`  |

Binary after build: `dist/cli.js` (package bin name `implementer`).

## Run

Workspace must already exist. Example with no Gates:

```bash
npm run build
node dist/cli.js \
  --id task-1 \
  --intention "do the work" \
  --definition-of-done "checks pass" \
  --workspace /absolute/path/to/workspace \
  --builder -- node /path/to/builder.js \
  --builder-timeout-ms 60000 \
  --max-attempts 3
```

Each child has its own ceiling: `--builder-timeout-ms` (required), and `--gate-timeout-ms` before each `--gate`. There is no Attempt clock and no Task clock.

Progress is JSON lines on stdout (`status`, `attempt-started`, `builder-finished`,
`gate-finished`, `attempt-finished`, `run-finished`). Exit codes: `0` validated,
`1` escalated, `2` invalid-invocation, `130` interrupted.

## Import

Same Transformer, in process. `cli.ts` is an adapter over this function — it reads argv
and stdin, calls `runImplementer`, and maps the outcome to an exit code. Nothing the CLI
can do is unreachable from here.

```ts
import { runImplementer } from "@bluewombat/implementer";

const result = await runImplementer({
  invocation,                       // same shape the CLI builds from argv
  write: (line) => events.push(line), // progress as values, not stdout
});
```

`src/index.ts` exports `runImplementer`, its `RunOptions` / `RunResult`, `ProgressWriter`,
and this Transformer's domain types.

## Layout

```
SPECS.md                 behavioural contract
README.md                how to build and run
src/
  cli.ts                 entry
  types.ts               Transformer-owned types
  args/                  CLI parsing
  loop/                  pure Attempt-loop decisions
  status/                Status labels and --on-status
  progress/              JSON-line progress writer
  child/                 spawn, Builder, Gate
  run/                   invocation orchestration
fixtures/                fake Builder / Gate scripts for tests
```

Sources stay colocated: helpers used once live next to their caller.
