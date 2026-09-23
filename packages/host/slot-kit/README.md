# Slot kit

What a slot needs to answer the Transformer that spawned it.

A slot is an opaque command. Implementer spawns a Builder and its Gates,
FeatureBreakdown spawns a Planner, and each one reads argv and writes **one JSON
line on stdout**. That is the whole contract, and nothing here is required to
meet it: a shell script that prints the right line is a Gate. This package is
the plumbing every slot written in Node would otherwise write again — and it is
what keeps the shipped slots from each growing their own version of it.

The contract line must be written with `writeContract` (or an `emit*` that uses
it). `process.stdout.write` followed by `process.exit` drops the tail of any
payload larger than the pipe buffer — a finished Cursor/Claude stream-json run
used to reach the role as "The agent command wrote no result." Diagnostics on
stderr use `writeDiagnostic` for the same reason.

The behaviour a slot must have is specified where its caller is:
[Implementer](../../kernel/implementer/SPECS.md) for Builders and Gates,
[FeatureBreakdown](../../kernel/feature-breakdown/SPECS.md) for Planners.
Slots that use this kit: [`@bluewombat/slots`](../../plugins/slots/README.md).

## Install

```bash
npm install @bluewombat/slot-kit
```

## A Gate

```js
#!/usr/bin/env node
import { GATE_FLAGS, emitVerdict, ownArgv } from "@bluewombat/slot-kit";

const globs = ownArgv(process.argv, GATE_FLAGS);
if (globs.length === 0) {
  emitVerdict("fail-blocking", "This Gate needs at least one glob.");
  process.exit(0);
}
emitVerdict("pass");
```

`ownArgv` is the first thing a slot needs: it is spawned with its own options
first and the caller's flags appended, and it must not trip over the second set.

## What it holds

| Area       | Exports                                                                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| argv       | `ownArgv`, `splitRunner`, `take`, `stageOf`, `GATE_FLAGS`, `BUILDER_FLAGS`, `PLANNER_FLAGS`                                                                            |
| options    | `parseOptions` — a spec of flags, with choices, fallbacks and repeatable ones                                                                                          |
| stdout     | `emitVerdict`, `emitFailure`, `emitPlan`, `emitRefusal`, `writeContract`, `writeDiagnostic` — emits use `writeContract` so `process.exit` cannot truncate |
| agent CLIs | `findExecutable`, `runAgent`, `readResult`, `serializeRun`, `extrasOf`, `finishRun`, `failureOf` — `serializeRun` always writes `skills` / `usage` (`null` = unknown)  |
| prompts    | `renderPrompt`, `readTemplate`, `PROMPT_RULES` — fill is generic; each role owns its names                                                                             |
| roles      | `parseRole`, `loadPrompt`, `loadRules`, `fillPrompt`, `spawnFilled`, `transcriptArgs`, `ROLE_OPTIONS` — a role fills its template and hands it to the agent after `--` |
| transcript | `openTranscript`, `transcriptFor`, `TRANSCRIPT_PARTS`, `skillsLabel`, `usageLabel` — optional extras on `write`                                                        |
| plans      | `checkPlan`                                                                                                                                                            |
| paths      | `pathMatchesGlob`                                                                                                                                                      |

Each `emit*` takes an optional `write`, which is how they are tested without a
process. Everything else is a plain function over its arguments; `finishRun` is
the one exception, and ends the process on purpose.

## The three roles

| Role    | Spawned by       | Answers                                                                       |
| ------- | ---------------- | ----------------------------------------------------------------------------- |
| Planner | FeatureBreakdown | `{"subtasks":[…]}`, or `{"outcome":"refused",…}` for an unsplittable one      |
| Builder | Implementer      | Nothing on a pass — the workspace is the answer. `{"outcome":…}` on a failure |
| Gate    | Implementer      | `{"verdict":"pass"}`, or `fail-retryable` / `fail-blocking` with a `report`   |

A verdict is not an exit code. A Gate that exits non-zero without a line on
stdout has not answered.

## Stack

Repository stack — TypeScript, Node 24.20, Biome, `node:test`. See
[docs/DEVELOPMENT.md](../../../docs/DEVELOPMENT.md).

## Commands (development)

| Task      | Command          |
| --------- | ---------------- |
| Lint      | `npm run lint`   |
| Format    | `npm run format` |
| Typecheck | `npm run tsc`    |
| Test      | `npm test`       |
| Build     | `npm run build`  |

## Layout

```
src/
  index.ts       the whole surface
  argv.ts        who each argv token belongs to
  options.ts     a slot's own flags
  emit.ts        the one line on stdout
  agent.ts       find, run, and read an agent CLI
  finish.ts      how a finished agent run classifies
  prompt.ts      generic fill, rules, agent prompt (already rendered)
  role.ts        parse a role, fill its template, spawn the agent after `--`
  transcript.ts  one file per turn, when a Project asks for one
  plan.ts        whether a Plan can be acted on
  glob.ts        path globs
```
