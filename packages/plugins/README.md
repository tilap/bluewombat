# Plugins

What a Project names in its config and Host loads — or spawns — by that name.
Each package here answers one contract and knows nothing of who calls it.

| Package                                          | Contract                                                            | Named in                       |
| ------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------ |
| [`manager-github/`](./manager-github/)           | `createManager` → `ManagerPort` (`@bluewombat/manager-kit`)              | `manager`                      |
| [`manager-fake/`](./manager-fake/)               | Same, over a directory: what the tests and a first run use          | `manager`                      |
| [`isolation-git/`](./isolation-git/)             | `strategy: { isolation, fold, reference, refOf }` — git worktrees   | `workLine.isolation`           |
| [`isolation-copy/`](./isolation-copy/)           | `strategy: { isolation, fold }` — directory copy                    | `workLine.isolation`           |
| [`persist-fs/`](./persist-fs/)           | `openPersist({ ledgerRoot })` → Persistence Port — one JSON per key | `persist` (the default)        |
| [`persist-sqlite/`](./persist-sqlite/)   | Same — one SQLite file                                              | `persist`                      |
| [`slots/`](./slots/)                             | Commands that print one JSON line: Planner, Builder, Gate, Agent…   | `planner`, `builder`, `gates`… |

## The rule

**A plugin imports its kit and the kernel Ports it implements — never
`@bluewombat/runtime`, never another plugin.** `scripts/check-plugins.mjs`
enforces it (dependencies and imports, tests excepted). The contracts a plugin
answers are published as kits under [`packages/host/`](../host/README.md);
the Persistence Port is `@bluewombat/work-ledger`'s, and the isolation backends
are `@bluewombat/isolator`'s and `@bluewombat/integrator`'s.

A third-party plugin is the same thing in another repository: it depends on the
kit from npm, and a config names it. Nothing in this directory is special to
Host beyond being the defaults it ships with.

## Add one

- A tracker: a new `manager-*` directory, `createManager` exported. Host does
  not change. Contract: [`manager-kit/README.md`](../host/manager-kit/README.md).
- An isolation method: a new `isolation-*` directory exporting `strategy`
  (`isolation`, `fold`; `reference` and `refOf` when it can). Isolator and
  Integrator do not change.
- A ledger backend: a new `persist-<name>` directory implementing the
  Persistence Port and exporting `openPersist({ ledgerRoot })`. The ledger
  package does not change.
- A slot: any command that prints the right line, here when it ships with
  mason, anywhere when it does not. Contract:
  [`slot-kit/README.md`](../host/slot-kit/README.md).

Same repository stack as the kernel; npm names stay under `@bluewombat/`.
