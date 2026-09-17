# persist-fs

Persistence Port for WorkLedger: one JSON file per FeatureStandard key, atomic
rename on save. The ledger never imports this package. Glue does.

```ts
import { openWorkLedger } from "@bluewombat/work-ledger";
import { openFilesystemPersist } from "@bluewombat/persist-fs";

const persist = await openFilesystemPersist({ root: "/absolute/path/to/ledger" });
const ledger = openWorkLedger({ persist });
```

This is what Host uses when a config says nothing (`"persist"` unset): it calls
`openPersist({ ledgerRoot })`, one JSON file per key directly under the root.

`root` must be absolute. The adapter creates it if missing.

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
