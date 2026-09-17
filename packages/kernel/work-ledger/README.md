# WorkLedger

Kernel package: the durable store of FeatureStandards, Subtasks, states,
Attempts, and Traces. Glue writes here before it acts.

Behavioural contract: [SPECS.md](./SPECS.md). Persistence adapters live under
`packages/` (`@bluewombat/persist-fs`, `@bluewombat/persist-sqlite`). This
package owns the Port, not the bytes.

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

There is no CLI in this implementation. Glue injects a persistence adapter and
calls commands on the returned ledger.

```ts
import { openWorkLedger } from "@bluewombat/work-ledger";
import { openFilesystemPersist } from "@bluewombat/persist-fs";

const persist = await openFilesystemPersist({ root: "/absolute/path/to/ledger" });
const ledger = openWorkLedger({ persist });
```

SQLite is the same Port:

```ts
import { openSqlitePersist } from "@bluewombat/persist-sqlite";

const persist = await openSqlitePersist({ path: "/absolute/path/to/ledger.sqlite" });
```

## Layout

```
SPECS.md                 behavioural contract
README.md                how to build and run
src/
  index.ts               openWorkLedger; records; Persistence Port
  records.ts             persisted shapes (no behaviour)
  persist/port.ts        Persistence Port only
  ledger/                commands and queries (imports Port, not an adapter)
```
