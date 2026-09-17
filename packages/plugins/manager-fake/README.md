# Manager: fake

The FeatureManager triplet that needs no account: a directory of JSON files is
the Source, a directory of `.ndjson` Threads is the report.
Contract: [SPECS.md](./SPECS.md).

```bash
npm install @bluewombat/runtime @bluewombat/manager-fake
npx mason init --manager @bluewombat/manager-fake
```

```json
{
  "manager": "@bluewombat/manager-fake",
  "managerOptions": { "source": "./.mason/source", "target": "./.mason/threads" }
}
```

## Options

| Option            | Required | Default | Meaning                                                         |
| ----------------- | -------- | ------- | --------------------------------------------------------------- |
| `source`          | yes      | —       | Directory of raw intentions. Must exist. Relative to the config |
| `target`          | yes      | —       | Directory the Threads are appended to. Created if absent        |
| `defaultPriority` | no       | `50`    | Priority for a raw intention that carries none (0…100)          |

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

## Layout

```
SPECS.md      the contract
README.md     how to build and configure it
src/
  index.ts    createManager, checkManager, scaffoldManager — the plugin face
  manager.ts  the ManagerPort (listen / adapt / report live in listener/, adapter/, emitter/)
```
