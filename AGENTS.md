# Agent guide — bluewombat

Read this first when starting a session on this project.

## 1. Project context

- **Goal**: Autonomously turn a user intention into a delivered final solution
- **Type**: Autonomous project-execution system, as a repo of independent Transformers
- **Names**: *bluewombat* is the system — the repository, the npm scope `@bluewombat/`, the rules in `docs/PRODUCT.md`. *mason* is its command-line tool: the binary, `mason.config.json`, `.mason/`, the tracker labels. Say "bluewombat does X" for a rule, "`mason run` does X" for the process
- **Stack**: TypeScript / Node 24.20 / Biome / `node:test` / Turborepo — [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)

## 2. Where to look

**[docs/INDEX.md](./docs/INDEX.md) is the routing table.** It lists every document with a
one-line summary and a freshness status. Read it, pick the one or two documents that
answer your question, and open only those. Do not load the whole `docs/` set.

| You need                                                            | Go to                                                                                   |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Domain vocabulary, user roles, business rules                       | `docs/PRODUCT.md`                                                                       |
| Structure, entry points, where to add code                          | `docs/ARCHITECTURE.md`                                                                  |
| Why something is the way it is                                      | `docs/DECISIONS.md`                                                                     |
| Theoretically normal but easy to get wrong                          | `docs/FOR_DUMMIES.md`                                                                   |
| What is **not** settled, or was never proved                        | `docs/RESERVATIONS.md`                                                                  |
| How to run, test, deploy                                            | `docs/DEVELOPMENT.md`, `docs/TESTING.md`, `docs/RUNBOOKS.md`                            |
| A Transformer's binary or CLI                                       | That Transformer's own docs under `packages/kernel/` — not root `docs/`                 |
| The repository toolchain                                            | `docs/DEVELOPMENT.md`                                                                   |
| Host and its kits                                                   | [`packages/host/README.md`](./packages/host/README.md)                                  |
| A manager, an isolation, a persistence backend, a slot              | [`packages/plugins/README.md`](./packages/plugins/README.md)                            |
| Kernel packages that are not Transformers                           | [`packages/kernel/README.md`](./packages/kernel/README.md)                              |
| The workflow, its rules, the human surface, the words               | `docs/PRODUCT.md`                                                                       |
| What no unit suite proves, and what was deleted with `integration/` | `docs/RESERVATIONS.md` § U11                                                            |
| Who exists, who may import whom                                     | `packages/README.md`                                                                    |
| Operator live view (`mason watch`), the journal, streams            | `packages/host/runtime/SPECS.md` § 8; what it still lacks: `docs/RESERVATIONS.md` § I10, I12–I15 |
| Implementer Transformer specification                               | `packages/kernel/implementer/SPECS.md`                                                  |
| Isolator Transformer specification                                  | `packages/kernel/isolator/SPECS.md`                                                     |
| Integrator Transformer specification                                | `packages/kernel/integrator/SPECS.md`                                                   |
| FeatureBreakdown Transformer specification                          | `packages/kernel/feature-breakdown/SPECS.md`                                            |
| Transformer contract (all of them)                                  | `packages/kernel/README.md` (§ Transformers)                                            |
| WorkLedger specification                                            | `packages/kernel/work-ledger/SPECS.md`                                                  |
| Conductor specification                                             | `packages/kernel/conductor/SPECS.md`                                                    |
| Host specification                                                  | `packages/host/runtime/SPECS.md`                                                        |
| Planner / Builder / Gate contract                                   | `packages/host/slot-kit/README.md`; the behaviour is in the caller's SPECS              |

Project-specific conventions (design, domain rules): `.cursor/rules/` and `CLAUDE.md`
when present — they override generic defaults.

## 3. Trusting the docs

Each root document declares `covers`: the files it describes. A change to
those files is a change to that document, in the same commit — there is no
"verified on" date to lean on, the document is either right or it is a bug.
When a document and the code disagree, the code is the fact and the document
is what you fix, unless the document is `PRODUCT.md`: then the product changed
first and the code is late.

`docs/PRODUCT.md` is the product: tool-agnostic, rules and words. A product
fact changes there before the code does. Root `docs/` stays global: product,
layout, the shared toolchain, cross-cutting concepts, decisions, reservations.
Do not put a package's CLI there.

## 4. Before coding

1. `docs/INDEX.md` — which documents cover this area?
2. `docs/DECISIONS.md` — is there an accepted decision constraining this work?
3. `docs/RESERVATIONS.md` — is this area already known to be unsettled or unproved?
4. `docs/ARCHITECTURE.md` — invariants and extension points for the area you touch

## 5. After coding

| Change                                                                                           | Update                                                                                       |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Structural or technology choice made                                                             | New entry in `docs/DECISIONS.md`                                                             |
| A call nobody validated, a defect left alone, code never run for real, something left improvable | New entry in `docs/RESERVATIONS.md`                                                          |
| Structure, entry point, or invariant changed                                                     | `docs/ARCHITECTURE.md`                                                                       |
| Domain term added or renamed                                                                     | `docs/PRODUCT.md` glossary                                                                   |
| Setup, command, or env variable changed                                                          | repo toolchain → `docs/DEVELOPMENT.md`; a Transformer's CLI or env → that Transformer's docs |
| A document added, moved, or retired                                                              | `docs/INDEX.md`                                                                              |

A document that says what *will* exist is a reservation, not a doc: put the
plan in `docs/RESERVATIONS.md` and keep the document on the present.

## 6. Working agreements

- **Write down what you are not sure about.** Every time you make a call nobody
  validated, notice a defect you are not fixing, ship code you never saw run
  against the real thing, or leave something working but worse than it could be
  — add an entry to `docs/RESERVATIONS.md`, in the same change. Say where it is,
  what it is, and for a choice, the alternative you did not take. A doubt left
  unsaid reads as confidence you do not have, and it is the one thing a reader
  cannot recover afterwards. Remove an entry when it is settled, and record a
  settled choice in `docs/DECISIONS.md` on the way out.
- Code, comments, and documentation in English
- Minimal diff — only change what the task requires
- A decision in `docs/DECISIONS.md` changes in the same commit as the code it governs, and the commit says what it replaced
- Ask before overwriting custom work or deviating from an accepted decision
- Do not commit unless the user explicitly asks
- Domain words in `docs/PRODUCT.md` are the only names for those concepts
- Transformers do not depend on each other; wire them only in Host
- The toolchain is the repository's: no per-package `.nvmrc`, `biome.json`, or lockfile
