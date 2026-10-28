---
title: Feature tests
summary: How a Feature is proved by its own tests, why it replaced the e2e suite, what it does not guarantee, and what is open.
covers:
  - packages/plugins/slots/gates/feature-tests.mjs
  - packages/plugins/slots/builders/feature-test.mjs
  - packages/plugins/slots/gates/tests-only.mjs
---

# Feature tests

How bluewombat proves that a Feature does what was asked. The rules are in
[PRODUCT.md](./PRODUCT.md); the choices and what they replaced are in
[DECISIONS.md](./DECISIONS.md); what is unproved is in
[RESERVATIONS.md](./RESERVATIONS.md) (C37, F35, U22, I17). This note gives the picture and the history.

## What there is

| Level | What | Where it is configured |
| --- | --- | --- |
| A Ticket | The Builder's Gates: `typecheck`, `tests`, `lint`. The producer writes the tests of its task with its code | `ticket.build.gates` |
| A Feature, its own tests | A last Ticket, made by another agent than the one that built the Feature, writes one test per scenario of the PRD and a manifest, may change only tests (`tests-only` Gate), and runs them against the built Feature through the `feature-tests` Gate after each attempt; the same Gate runs **only those** once more on the assembled line | `feature.test` and its `tests-only` Gate, the `feature-tests` Gate in `feature.validate.gates` |
| A Feature, after a red run | The fix repairs the application; the tests are frozen | `feature.fix.gates` |
| The whole suite | The Project's CI, when the Feature is merged. Not run by mason during a Feature | the Project |

## Why it is not an e2e suite

It was one, and it was stopped on `orangemonkey-site#106` (2026-10-25): the Gate refused 7 scenarios
because it capped the manifest at 5. That manifest was the suite of the whole application, so the cap
counted every earlier Feature too, and the cap lived nowhere in the Project's config. Looking at it
showed more than the bug:

- A suite of the whole application grows with each Feature; running it on every Feature is long, and a
  cap on its size has no right value.
- No Project of this kind has browser e2e tests yet, and driving a real application from a Gate
  (start, wait, stop) is heavy. The scenarios of #106 were service and route behaviour for the most part.
- Tests written first, per Ticket (`builder.tests`), had been tried and looped and cost too much on
  each Ticket; it was removed (2026-10-27) with its Gates and its label. The tests of a Feature,
  written once at its end, are the compromise.

So the check is now the Feature's own tests, at the level its scenarios name, run alone. The
`--max-scenarios` option, the application's `--up`/`--ready`/`--down`, the retry and the
`E2E_*` environment are gone, with no compatibility. The ledger's `e2e` and `skip_e2e` fields,
the tracker labels `e2e` and `skip-test-e2e` and the config key `builder.e2e` became `featureTest`,
`skip_feature_test`, `feature-test`, `skip-feature-test` and `feature.test`: a ledger or a
config written before must be changed by hand.

## What the first real run showed

On `orangemonkey-site#106` the tests had been written without ever being run. Run for the first time
by the Feature's Gate, they showed three things: a defect of the Feature itself (the worker's `claim`
used a database transaction that the production driver, neon-http, does not have: HTTP 500, invisible
to the unit tests that run on an in-memory database), and two wrong tests (a row looked up by the
URL where the page shows the title, an `isVisible()` read before the page had rendered). The fix cannot
edit tests, so a person corrected them one by one. The feature-test Ticket therefore runs its tests
against the built Feature, through the same Gate, and iterates; a red run that is the Feature's fault
ends in `MASON_BLOCKED` with a diagnosis.

## What it does not guarantee

The agent that writes the tests sees the code, so a test can describe what the code does instead of
what was asked, and no prompt makes that impossible. What limits it: the scenarios come from the
PRD and are copied verbatim; its tests are run before it is done; the fix cannot edit the tests; the
Gate refuses a deleted, skipped or unowned test; the Builder stops with `MASON_BLOCKED` rather than
weaken a scenario. Nothing reads a test against its scenario, and a scenario weakened upstream
(ticket #114 lowered `E6` from `done` to `transcribed`) is not flagged. Metrics will tell whether
this is enough.

## Open

- The manifest is one file that every Feature rewrites; two Features in parallel may conflict on it.
- Running the Project's whole suite at the final merge (a `validate-ci` step) is the Project's CI for
  now; `feature.gates: ci-green` waits for it but does not require that it runs the whole suite.
- Whether the tests of a Feature are kept or removed once it is merged is not decided: they stay, as
  ordinary tests of the Project, and may become obsolete.
- Where the PRD and its scenarios are written is outside this repository.
