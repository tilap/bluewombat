# Integrator

Transformer: runs **one Integration**. It takes a Child directory and a
Parent directory, both already existing, and folds the Child's working files
into the Parent. Never forced: `integrated` or `conflict`.

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

Binary after build: `dist/cli.js` (package bin name `integrator`).

## Run

Parent and Child must already exist. Example:

```bash
npm run build
node dist/cli.js \
  --id feat-1 \
  --parent /absolute/path/to/parent \
  --child /absolute/path/to/child \
  --duration-ms 60000 \
  --strategy @bluewombat/isolation-copy
```

The CLI requires `--strategy`: a package name or path that exports `strategy` with a `fold` backend. Integrator does not sniff `.git` and does not choose git versus copy.

Progress is JSON lines on stdout (`status`, `integration-started`,
`integration-finished`). Exit codes: `0` integrated, `1` conflict, `2`
invalid-invocation, `3` failed, `130` interrupted.

## Import

Same Transformer, in process. `cli.ts` is an adapter over this function — it reads argv
and stdin, calls `runIntegrator`, and maps the outcome to an exit code. Nothing the CLI
can do is unreachable from here.

```ts
import { strategy } from "@bluewombat/isolation-copy";
import { runIntegrator } from "@bluewombat/integrator";

const result = await runIntegrator({
  invocation,                       // same shape the CLI builds from argv
  backend: strategy.fold,           // Host / CLI loads a strategy package
  write: (line) => events.push(line), // progress as values, not stdout
});
```

`src/index.ts` exports `runIntegrator`, `FoldBackend`, `RunOptions` /
`RunResult`, `ProgressWriter`, and this Transformer's domain types. Isolation
strategies live under `packages/plugins/isolation-*`.

## Layout

```
SPECS.md                 behavioural contract
README.md                how to build and run
src/
  cli.ts                 entry
  types.ts               Transformer-owned types
  args/                  CLI parsing
  status/                Status labels and --on-status
  progress/              JSON-line progress writer
  child/                 spawn (--on-status)
  fold/                  fold via injected FoldBackend (snapshot restore + contract)
  run/                   invocation orchestration
fixtures/                fake --on-status scripts for tests
```

Sources stay colocated: helpers used once live next to their caller.
