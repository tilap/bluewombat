# Kernel

Tracker-agnostic core. The same packages could deliver a book: they speak
intention, plan, attempt, directory — not GitHub, not a git remote, not a file
format.

| Package          | Directory                                    | Shape                                                                  |
| ---------------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| Isolator         | [`isolator/`](./isolator/)                   | Transformer — Parent directory in, isolated Child out                  |
| Implementer      | [`implementer/`](./implementer/)             | Transformer — one Task in an existing directory                        |
| Integrator       | [`integrator/`](./integrator/)               | Transformer — fold Child into Parent, never forced                     |
| FeatureBreakdown | [`feature-breakdown/`](./feature-breakdown/) | Transformer — FeatureStandard in, Plan or refuse                       |
| Conductor        | [`conductor/`](./conductor/)                 | Sequencer. Many operations. Injected transformers, writes WorkLedger first   |
| WorkLedger       | [`work-ledger/`](./work-ledger/)             | Durable store. Persistence Port only — adapters live under `packages/` |

Host, tracker managers, and persistence adapters are **not** kernel:
[`packages/README.md`](../README.md).

A Transformer does not import a kernel sibling or a `packages/` package.
Conductor may import WorkLedger. Host (in `packages/`) wires Transformers.

Nothing here imports the two kits either. `packages/host/manager-kit` is the contract
a manager implements for Host; `packages/host/slot-kit` is what a slot written in
Node imports to answer the Transformer that spawned it. A Transformer only
knows the JSON line a slot prints, so both kits sit on the `packages/` side of
that line, with what implements them.

## Autonomy

Every package here is published on npm on its own, so it must stand on its
own. `scripts/check-kernel.mjs` (run by `npm run lint`) asserts, for every
directory under `packages/kernel/`:

- a source file imports Node (`node:*`), a declared dependency, or a file of
  the same package — never a path that leaves the package, never an undeclared
  bare specifier;
- the only `@bluewombat/*` dependency is the one this README allows
  (Conductor → WorkLedger); a new one is a decision, recorded here first;
- `exports`, `bin`, `types` all point inside `files`, `publishConfig.access`
  is `public`, `repository.directory` is the package path;
- `README.md`, `src/index.ts`, `tsconfig.json`, and at least one `*.test.ts`
  under `src/` exist.

A change under `packages/kernel/` is a change to a published package: keep its tests
and its `SPECS.md` in step, and do not reach for `packages/` to make it easier.

## Transformers

Every Transformer package under this directory obeys the same contract, faces,
and independence rules. Read this section before adding or editing one. A
Transformer's own README is how to invoke it — not a second copy of these rules.

A Transformer is **one IN, work in the middle, one OUT**. It is not a store, not
a sequencer, not a process, not a tracker plugin.

| Transformer      | Path                                         | IN                                 | OUT                                       |
| ---------------- | -------------------------------------------- | ---------------------------------- | ----------------------------------------- |
| Isolator         | [`isolator/`](./isolator/)                   | parent directory + an id           | a new isolated child directory            |
| Implementer      | [`implementer/`](./implementer/)             | prompt + an existing directory     | `validated` / `escalated` / `interrupted` |
| Integrator       | [`integrator/`](./integrator/)               | child directory + parent directory | `integrated` or `conflict` (never forced) |
| FeatureBreakdown | [`feature-breakdown/`](./feature-breakdown/) | FeatureStandard                    | Plan (Subtasks) or refuse                 |

Host wires them. Conductor sequences them through an injected Transformer Port. A
FeatureManager lives under [`packages/`](../README.md) (`manager-*`).

### Contract (all of them)

Every Transformer obeys this, on the shared toolchain. Breaking a row is a spec
bug, not a style choice. `scripts/check-kernel.mjs` asserts the
mechanical parts, on top of § Autonomy.

| Face         | Entry point                      | Carries                                                                          |
| ------------ | -------------------------------- | -------------------------------------------------------------------------------- |
| Import       | `src/index.ts` → `dist/index.js` | the run function, its `RunOptions` / `RunResult`, `ProgressWriter`, domain types |
| Command line | `src/cli.ts` → `dist/cli.js`     | argv and stdin in, JSON lines on stdout, an exit code                            |

`cli.ts` reads argv and stdin, calls the run function, and maps the outcome to an
exit code. Nothing else.

- The run function takes its inputs as arguments — no `process.argv`, no
  `process.env`, no `process.cwd()`, no stdin read from inside it.
- Effects are injected, not assumed: progress goes through a `ProgressWriter`.
- The outcome is a returned value. `process.exit()` belongs to `cli.ts` alone.
- Process signals belong to the binary. The run function never installs SIGINT
  or SIGTERM; the CLI owns the `interruptFlag` it passes in.
- No module-level mutable state, so two Transformers can run in one process.
- Required files: `package.json` (export + `bin`), `src/index.ts`, `src/cli.ts`,
  `SPECS.md`, `README.md`, `tsconfig.json` extending `tsconfig.base.json`.
- Same scripts as siblings: `lint`, `format`, `tsc`, `test`, `build`.
- No `.nvmrc`, no `biome.json`, no lockfile.

The one deliberate exception is the child-spawning adapter
(`src/child/run-child.ts`), whose whole job is the process boundary. A spawned
child inherits the caller's directory and environment when the Transformer was
given none — that is Node's own `spawn` behaviour, and `cwd` / `env` on the run
function override it.

Why both faces: the glue is TypeScript, so it can import a Transformer; but a
Transformer may be replaced by one that is not TypeScript, and Builder and Gates
are spawned commands either way. The two faces come from one build.

### Independence

A Transformer takes **no** dependency on:

- another Transformer
- a kernel package (`conductor`, `work-ledger`)
- a package under `packages/` (Host, a manager, a persistence adapter)

An external npm dependency is allowed: it is versioned per Transformer and makes
no sibling wait.

npm names stay `@bluewombat/<name>`. Binary names are unscoped: `isolator`,
`implementer`, …

### Adding one

New directory under `packages/kernel/` matching a sibling Transformer. Copy the faces and
scripts from a sibling. Put the IN/OUT in the table above. Register it in
`scripts/check-kernel.mjs`. Do not put CLI docs in root `docs/`.

Toolchain: [`docs/DEVELOPMENT.md`](../../docs/DEVELOPMENT.md). The three groups
and who may import whom: [`packages/README.md`](../README.md). Repo layout:
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).
