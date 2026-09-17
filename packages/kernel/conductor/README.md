# Conductor

Kernel package, not a Transformer: sequences Transformers for one FeatureStandard. It
writes the WorkLedger before it acts. Isolated workspaces are a consequence of
that state.

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

There is no CLI in this implementation. The caller injects a WorkLedger and a
Transformer Port (Isolation, Breakdown, Implementer, Integration).

**Optional Authority.** When injected, Conductor offers the assembled feature
and does not fold it into WorkLineStable itself. See [SPECS.md](./SPECS.md) §8.

```ts
import { openConductor } from "@bluewombat/conductor";

const conductor = openConductor({
  ledger,
  transformers,
  workLineStable: "/absolute/path/to/stable",
  workspaceRoot: "/absolute/path/to/workspaces",
});
```

## Layout

```
SPECS.md                 behavioural contract
README.md                how to build and run
src/
  index.ts               openConductor
  transformers/port.ts         Transformer Port
  run/                   loop, pause, reconcile (imports Port + WorkLedger)
```
