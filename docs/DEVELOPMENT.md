---
title: Development
summary: How to work in this repo — Node 24.20, Biome, node:test, Turborepo, and the everyday commands.
covers:
  - "package.json"
  - "package-lock.json"
  - "turbo.json"
  - "biome.json"
  - "tsconfig.base.json"
  - ".nvmrc"
---

# Development

Daily working guide for the **repository**. A Transformer's binary and CLI still live
next to that Transformer. The toolchain does not.

The product: [PRODUCT.md](./PRODUCT.md). Layout:
[ARCHITECTURE.md](./ARCHITECTURE.md).

## Setup

```bash
nvm use
npm install
```

**Prerequisites**: Node.js 24.20.0 (see `.nvmrc` at the repository root). `nvm`
walks up from a package directory and finds that file.

Workspaces: `packages/kernel/*`, `packages/host/*`, `packages/plugins/*`. One lockfile at the
root. Turborepo runs `build`, `test`, `lint`, `tsc`, and `format` across them.

## Stack

Every workspace package uses this stack. Do not add a per-package `.nvmrc`,
`biome.json`, or `package-lock.json`.

| Piece         | Choice                        | Where                       |
| ------------- | ----------------------------- | --------------------------- |
| Language      | TypeScript                    | `tsconfig.base.json`        |
| Runtime       | Node.js 24.20.0               | `.nvmrc`                    |
| Lint / format | Biome                         | `biome.json`                |
| Tests         | Node.js test runner via `tsx` | `"test"` in each package    |
| Task runner   | Turborepo                     | `turbo.json`                |
| Package graph | npm workspaces                | `package.json` `workspaces` |

A Transformer may still take an **external** npm dependency. It must not import
another Transformer, a kernel sibling, or a `packages/` package. A manager package may take `@octokit/core`
the same way — it is not a Transformer.

## Environment

No repository-wide environment variables. A variable a Transformer or a manager
package reads belongs in that package's own README, not here.

## Everyday commands

From the repository root:

| Task                | Command                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Build everything    | `npm run build`                                                                                                       |
| Test everything     | `npm test`                                                                                                            |
| Lint                | `npm run lint`                                                                                                        |
| Format              | `npm run format`                                                                                                      |
| Typecheck           | `npm run tsc`                                                                                                         |
| One package         | `npx turbo run test --filter=@bluewombat/implementer`                                                                 |
| Start a Transformer | that Transformer's CLI — see its README                                                                               |
| Put `mason` on PATH | `npm run dev:link` (undo: `npm run dev:unlink`)                                                                       |
| Cut a release       | [RUNBOOKS.md](./RUNBOOKS.md) § Deploy — a `v*` tag on `main`; first version by hand                                   |
| Run it for real     | `mason init` in a Project, then `mason run` — [`packages/host/runtime/README.md`](../packages/host/runtime/README.md) |

`npm test` (and `npm run build`) wait for workspace dependencies via
Turborepo `^build`. There is no per-package `pretest`. From a package
directory, `npm test` still works: npm walks up to the workspace root.

## Using the CLI while developing

`npm run dev:link` builds, then symlinks the `mason` binary globally. The link
points at `packages/host/runtime` in this repository, so `npm run build` is enough to
pick up a change — there is nothing to re-link.

```bash
npm run dev:link
```

It links the `mason` binary, both manager packages, and the slots. Then
`mason init`, `mason setup`, `mason doctor` and `mason run` work from any
directory. That is the whole development loop; nothing has to be published.

A Project reads those packages from its own `node_modules`, not from the global
link: `init` offers the managers it finds there, and every config path names
`./node_modules/@bluewombat/slots/…`. Link both into the project you are trying
it in:

```bash
npm link @bluewombat/manager-github @bluewombat/slots
```

Two things to know:

- The link lives in the **current Node version's** bin directory. Under nvm,
  switching Node hides `mason` until you run `npm run dev:link` again. The
  repository pins 24.20.0 in `.nvmrc`, so `nvm use` first.
- `npm run dev:unlink` removes it.

## Common changes

| To…                                    | Do                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a Transformer                      | New directory under `packages/kernel/` (sibling of `isolator`, …); add its name to `scripts/check-kernel.mjs`. Obey [`packages/kernel/README.md`](../packages/kernel/README.md) (§ Transformers). `node scripts/check-kernel.mjs` must pass                                                                                 |
| Add a kernel package                   | New directory under `packages/kernel/` that is not a Transformer. Not IN/OUT-shaped. See [`packages/kernel/README.md`](../packages/kernel/README.md)                                                                                                                                                                        |
| Add a manager, an isolation, a persist | New directory under `packages/plugins/`. See [`packages/plugins/README.md`](../packages/plugins/README.md); `node scripts/check-plugins.mjs` must pass                                                                                                                                                                      |
| Rename the product                     | `PRODUCT` in `packages/host/manager-kit/src/product.ts`, the `bin` and `keywords` in the manifests, then the docs; `node scripts/check-name.mjs` must pass. Branches are `issue/<n>` and do not carry the name                                                                                                              |
| Change Host                            | Pick the layer — `config`, `plugins`, `loop`, `operator` — and stay in it or below; `node scripts/check-host.mjs` must pass. Order of work and what each layer holds: [`packages/host/runtime/README.md`](../packages/host/runtime/README.md) § Layers; the three-group rule: [`packages/README.md`](../packages/README.md) |
| Change a domain word                   | Update the glossary in [PRODUCT.md](./PRODUCT.md) first, then the Transformers that use it                                                                                                                                                                                                                                  |
| Record a structural choice             | Add a row to [DECISIONS.md](./DECISIONS.md); do not rewrite an existing row                                                                                                                                                                                                                                                 |
| Change a Transformer's CLI or env      | Edit that Transformer's own docs, not this file                                                                                                                                                                                                                                                                             |
| Change Node, Biome, or TypeScript      | Edit the root files this document covers; bump every workspace only if a script must change                                                                                                                                                                                                                                 |

## Debugging

| Symptom                               | Look at                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unclear product rule                  | [PRODUCT.md](./PRODUCT.md)                                                                                                                                          |
| Unclear where code belongs            | [ARCHITECTURE.md](./ARCHITECTURE.md) — `kernel` vs `host` vs `plugins`; then [`packages/README.md`](../packages/README.md)                                          |
| Unclear how an operator watches a run | [`packages/host/runtime/README.md`](../packages/host/runtime/README.md) — `mason watch` / `status`, and `observability.streams` for what each child says; what it still lacks: [RESERVATIONS.md](./RESERVATIONS.md) § I10, I12–I15 |
| A Transformer will not start          | that Transformer's own docs                                                                                                                                         |
| Tests fail on missing `dist/`         | `npm run build` — or just `npm test`, which runs `^build` first                                                                                                     |

## Known traps

| Trap                                                               | Sign                                                        | Fix                                                                            |
| ------------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Describing a plan as if it were the present                        | A `docs/` file that says what will exist                    | `docs/` is the present; what is owed goes to RESERVATIONS.md                   |
| Using `ready` and `runnable` as if they were the same word         | Human signal confused with Subtask state                    | `ready` is human; `runnable` is Subtask state — see [PRODUCT.md](./PRODUCT.md) |
| Putting a Transformer's CLI in root `docs/`                        | DEVELOPMENT.md lists `--workspace` for Implementer          | Move argv next to the Transformer; this file stays the repo toolchain          |
| Adding a per-package `.nvmrc` or `biome.json`                      | A Transformer drifts off Node 24.20 or the shared formatter | Delete it; extend `tsconfig.base.json`; use the root Biome file                |
| Importing one Transformer from another                             | A Transformer grows a dependency on a sibling               | Wire them only in Host                                                         |
| A shared runtime helper under `packages/` that Transformers import | `packages/shared` or similar used from `packages/kernel/`   | Forbidden — that coupling is what workspaces do not buy                        |
