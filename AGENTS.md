# Agent guide — bluewombat

Read this first when starting a session on this project.

## 1. Project context

- **Goal**: Autonomously turn a user intention into a delivered final solution
- **Type**: Autonomous project-execution system, as a repo of independent Transformers
- **Names**: *bluewombat* is the system — the repository, the npm scope `@bluewombat/`, the rules in `docs/PRODUCT.md`. *mason* is its command-line tool: the binary, `mason.config.yaml`, `.mason/`, the tracker labels. Say "bluewombat does X" for a rule, "`mason run` does X" for the process
- **Stack**: TypeScript / Node 24.20 / Biome / `node:test` / Turborepo — [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)

## 2. Where to look

**[docs/INDEX.md](./docs/INDEX.md) is the routing table.** It lists every document with a
one-line summary and a freshness status. Read it, pick the one or two documents that
answer your question, and open only those. Do not load the whole `docs/` set.

| You need                                                            | Go to                                                                                                                                  |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Domain vocabulary, user roles, business rules                       | `docs/PRODUCT.md`                                                                                                                      |
| Structure, entry points, where to add code                          | `docs/ARCHITECTURE.md`                                                                                                                 |
| Why something is the way it is                                      | `docs/DECISIONS.md`                                                                                                                    |
| Theoretically normal but easy to get wrong                          | `docs/FOR_DUMMIES.md`                                                                                                                  |
| Work not done yet: defects, improvements, trials on a real Project  | `tilap/bluewombat` issues (`gh issue list`)                                                                                           |
| How to run, test, deploy                                            | `docs/DEVELOPMENT.md`, `docs/TESTING.md`, `docs/RUNBOOKS.md`                                                                           |
| How `@bluewombat/*` reaches npm                                     | `docs/RUNBOOKS.md` § Deploy. Push a `v*` tag on `main`; `.github/workflows/release.yml` publishes. Do not `npm publish` from a machine |
| A Transformer's binary or CLI                                       | That Transformer's own docs under `packages/kernel/` — not root `docs/`                                                                |
| The repository toolchain                                            | `docs/DEVELOPMENT.md`                                                                                                                  |
| Host and its kits                                                   | [`packages/host/README.md`](./packages/host/README.md)                                                                                 |
| A manager, an isolation, a persistence backend, a slot              | [`packages/plugins/README.md`](./packages/plugins/README.md)                                                                           |
| Kernel packages that are not Transformers                           | [`packages/kernel/README.md`](./packages/kernel/README.md)                                                                             |
| The workflow, its rules, the human surface, the words               | `docs/PRODUCT.md`                                                                                                                      |
| What no unit suite proves                                           | `docs/TESTING.md`; issues labelled `trial`                                                                                             |
| Who exists, who may import whom                                     | `packages/README.md`                                                                                                                   |
| Operator live view (`mason watch`), the journal, streams            | `packages/host/runtime/SPECS.md` § 8                                                                                                     |
| Implementer Transformer specification                               | `packages/kernel/implementer/SPECS.md`                                                                                                 |
| Isolator Transformer specification                                  | `packages/kernel/isolator/SPECS.md`                                                                                                    |
| Integrator Transformer specification                                | `packages/kernel/integrator/SPECS.md`                                                                                                  |
| Transformer contract (all of them)                                  | `packages/kernel/README.md` (§ Transformers)                                                                                           |
| WorkLedger specification                                            | `packages/kernel/work-ledger/SPECS.md`                                                                                                 |
| Conductor specification                                             | `packages/kernel/conductor/SPECS.md`                                                                                                   |
| Host specification                                                  | `packages/host/runtime/SPECS.md`                                                                                                       |
| Builder / Gate contract                                   | `packages/host/slot-kit/README.md`; the behaviour is in the caller's SPECS                                                             |

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
layout, the shared toolchain, cross-cutting concepts, decisions.
Do not put a package's CLI there.

## 4. Before coding

1. `docs/INDEX.md` — which documents cover this area?
2. `docs/DECISIONS.md` — is there an accepted decision constraining this work?
3. Open issues on `tilap/bluewombat` touching this area — is the work already described?
4. `docs/ARCHITECTURE.md` — invariants and extension points for the area you touch

## 5. After coding

| Change                                                                                           | Update                                                                                       |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Structural, technology or design choice made                                                     | New row in `docs/DECISIONS.md`                                                               |
| A limit of the code that holds by construction                                                   | The docs of the package that has it                                                          |
| Structure, entry point, or invariant changed                                                     | `docs/ARCHITECTURE.md`                                                                       |
| Domain term added or renamed                                                                     | `docs/PRODUCT.md` glossary                                                                   |
| Setup, command, or env variable changed                                                          | repo toolchain → `docs/DEVELOPMENT.md`; a Transformer's CLI or env → that Transformer's docs |
| A document added, moved, or retired                                                              | `docs/INDEX.md`                                                                              |

A document says what exists. What *will* exist is an issue.

## 6. Working agreements

- **Finish the task.** It is done when its goal is reached and proven: tests
  that prove it pass, `npm run build`, `npm run tsc`, `npm test` and
  `npm run lint` are green, and the docs covering the changed files say what
  the code now does.
- **Anything found on the way gets one outcome, at once.** On the path of the
  task, or broken by it: fix it in the same change. Real, independent and
  outside the task: open an issue on `tilap/bluewombat` (need and acceptance
  criteria in the body, leads in a first comment). The owner's call (product
  rule, an architecture choice with no settled answer, anything irreversible):
  stop and ask one question with a recommendation. Nothing is left as a
  remark in a reply, a comment or a document.
- **Work postponed on purpose stays open**, labelled `later`; `now` and `next`
  mark what is under way and what comes after. A closed issue is done or refused.
- **A choice you made is a decision.** Record it in `docs/DECISIONS.md` with
  what you turned down. The owner replaces the row if they disagree.
- Code, comments, and documentation in English
- No change outside the task, except what the task's path needs fixed
- A decision in `docs/DECISIONS.md` changes in the same commit as the code it governs, and the commit says what it replaced
- Ask before overwriting custom work or deviating from an accepted decision
- Do not commit unless the user explicitly asks
- Domain words in `docs/PRODUCT.md` are the only names for those concepts
- Transformers do not depend on each other; wire them only in Host
- The toolchain is the repository's: no per-package `.nvmrc`, `biome.json`, or lockfile
