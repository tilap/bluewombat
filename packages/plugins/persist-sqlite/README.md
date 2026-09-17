# persist-sqlite

Persistence Port for WorkLedger: one SQLite file, `node:sqlite`. The ledger
never imports this package. Glue does.

```ts
import { openWorkLedger } from "@bluewombat/work-ledger";
import { openSqlitePersist } from "@bluewombat/persist-sqlite";

const persist = await openSqlitePersist({ path: "/absolute/path/to/ledger.sqlite" });
const ledger = openWorkLedger({ persist });
```

`path` must be absolute. The adapter creates the parent directory if missing.

From a Project, name it instead and let Host load it:

```json
{ "persist": "@bluewombat/persist-sqlite" }
```

Host calls `openPersist({ ledgerRoot })`; the file is `<ledgerRoot>/ledger.sqlite`,
beside Host's own Cursor and journal. Install the package next to mason.

## Stack

Repository stack — TypeScript, Node 24.20, Biome, `node:test`. See [docs/DEVELOPMENT.md](../../../docs/DEVELOPMENT.md).

## Commands

| Task      | Command          |
| --------- | ---------------- |
| Lint      | `npm run lint`   |
| Format    | `npm run format` |
| Typecheck | `npm run tsc`    |
| Test      | `npm test`       |
| Build     | `npm run build`  |
