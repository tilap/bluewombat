# FeatureBreakdown

Transformer: runs **one Breakdown**. It takes one FeatureStandard and
produces one Plan — Subtasks with intentions, definitions of done, and
dependencies — or refuses. It does not execute a Subtask. It does not create a
directory. It does not store the Plan.

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

Binary after build: `dist/cli.js` (package bin name `feature-breakdown`).

## Run

The FeatureStandard is `--feature <json>`, or stdin until EOF when `--feature`
is omitted. Example:

```bash
npm run build
node dist/cli.js \
  --feature '{"key":"fake:42","intention":"Export CSV"}' \
  --max-feature-bytes 65536 \
  --max-units 20 \
  --planner -- node /path/to/planner.js \
  --planner-duration-ms 60000
```

Progress is JSON lines on stdout (`status`, `planner-finished`, `result`). Exit
codes: `0` planned, `1` refused, `2` invalid-invocation, `3` unavailable,
`130` interrupted.

## Import

Same Transformer, in process. `cli.ts` is an adapter over this function — it reads argv
and stdin, calls `runBreakdown`, and maps the outcome to an exit code. Nothing the CLI
can do is unreachable from here.

```ts
import { runBreakdown } from "@bluewombat/feature-breakdown";

const result = await runBreakdown({
  invocation,                       // same shape the CLI builds from argv
  featureJson,                      // what the CLI reads from stdin
  write: (line) => events.push(line), // progress as values, not stdout
});
```

`src/index.ts` exports `runBreakdown`, its `RunOptions` / `RunResult`, `ProgressWriter`,
and this Transformer's domain types.

## Layout

```
SPECS.md                 behavioural contract
README.md                how to build and run
src/
  cli.ts                 entry
  types.ts               Transformer-owned types
  args/                  CLI parsing
  feature/               FeatureStandard read and checks
  plan/                  Plan checks and fingerprint
  planner/               Planner spawn and stdout parse
  status/                Status labels and --on-status
  progress/              JSON-line progress writer
  child/                 spawn (Planner, --on-status)
  run/                   invocation orchestration
fixtures/                fake Planner / --on-status scripts for tests
```

Sources stay colocated: helpers used once live next to their caller.
