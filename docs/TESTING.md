---
title: Testing
summary: Where tests live, that `npm test` at the root runs them through Turborepo, and what no suite proves.
covers:
  - "package.json"
  - "turbo.json"
---

# Testing

Every suite lives next to the package it proves; this file says how they run
together and what none of them proves.

Product validation at runtime is still **Gates** on each Subtask and again on the
assembled feature — see [PRODUCT.md](./PRODUCT.md). That is not a substitute for
the suites below.

## Levels

| Level          | Covers                                                                                     | Location                                          | Run with                                              |
| -------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------- | ----------------------------------------------------- |
| Package        | One package in isolation; a plugin against its kit                                         | `src/*.test.ts` next to the code                  | `npm test` at the root, or `--filter=@bluewombat/…`    |
| Host, whole    | The chain listen → adapt → Conductor → real Transformers → report, on the fake manager     | `packages/host/runtime/src/loop/open-host*.test.ts` | same `npm test` — Turbo builds workspace deps first |
| Git remote     | `publish` / `refreshWorkLine` against a bare, single-branch remote on disk                 | `packages/host/runtime/src/loop/authority.test.ts` | same                                                 |
| Gate (product) | Subtask output, then feature assembly                                                      | The Project's Gate sequence, at runtime           | Implementer, not a developer command                  |

## What must pass before merge

From the repository root: `npm test`. That runs every workspace `test` script
through Turborepo. `test` depends on `^build`, so a package is built before the
one that imports it is tested.

`npm run lint` and `npm run tsc` are the other two gates; `lint` also runs the
three layout checks (`check-kernel`, `check-host`, `check-plugins`). CI wins if
this document and CI diverge.

## What no suite proves

Two things, both recorded in [RESERVATIONS.md](./RESERVATIONS.md) § U11 so
they are not forgotten: a Submission judged from outside by the **shipped**
Gates on a real git work line (the assembly that did this was deleted), and
the GitHub round trip — issue in, comments, labels, pull request, merge, then
the red variant — which belongs to a script and a pre-release checklist, never
to `npm test`. The one hard-won rule for making a CI go red on purpose is
written there too.

## Writing tests

- A test that needs two or more Transformers does not live inside a Transformer.
  Host's suite is where the chain is exercised; a plugin's suite exercises the
  plugin against its kit, not against Host.
- The runner is the Node.js test runner via `tsx`. Do not add a second framework
  in one package.
- Fixtures and mocks stay next to the suite they serve.

When runtime Transformers exist, tests that prove a Gate verdict (`pass` / `fail-retryable` /
`fail-blocking`) and admission idempotency on external identity should be first-class —
those are the product rules most expensive to get wrong.

## Deliberately not tested

Being explicit here prevents both false confidence and pointless coverage debates.

| Area                                              | Why not                         | Compensating control                    |
| ------------------------------------------------- | ------------------------------- | --------------------------------------- |
| A Transformer's internals                         | Root docs do not own that Transformer | That Transformer's own suite            |
| Business content the Builder produces             | Out of product scope            | Project Gates chosen per Project        |
| Concrete FeatureManager, versioning tool, Builder | Chosen per Transformer, not here      | Adapter / Emitter / producer boundaries |

## Flaky tests

- Policy: not defined at repo level; a Transformer may define its own
- Currently quarantined: none
