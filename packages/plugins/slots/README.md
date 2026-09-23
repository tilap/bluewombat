# Slots

The Planner, Builder, and Gate commands that ship with mason. A Project points
its config at one of these paths; nothing here is imported.

```json
"planner": ["node", "./node_modules/@bluewombat/slots/planners/one-subtask.mjs"],
"builder": {
  "producer": {
    "cmd": [
      "node", "./node_modules/@bluewombat/slots/builders/producer.mjs",
      "--prompt-file", "./build.md",
      "--",
      "node", "./node_modules/@bluewombat/slots/agents/claude.mjs"
    ],
    "timeoutMs": 600000
  },
  "repair": {
    "cmd": [
      "node", "./node_modules/@bluewombat/slots/builders/repair.mjs",
      "--prompt-file", "./repair.md",
      "--",
      "node", "./node_modules/@bluewombat/slots/agents/claude.mjs"
    ],
    "timeoutMs": 600000
  },
  "gates": {
    "defaultTimeoutMs": 120000,
    "gates": [
      {
        "id": "workspace-changed",
        "argv": ["node", "./node_modules/@bluewombat/slots/gates/workspace-changed.mjs"]
      }
    ]
  }
}
```

A slot is an opaque command: it reads argv and writes one JSON line on stdout.
These are examples of that contract, not a required layer — a shell script that
prints the right line is a Gate. What every slot written in Node would otherwise
write again lives in [`@bluewombat/slot-kit`](../../host/slot-kit/README.md);
these all use it. How Host wires a slot into a run:
[`@bluewombat/runtime`](../../host/runtime/README.md).

## Contents

- [Catalogue](#catalogue)
- [Agents](#agents)
- [Builders](#builders)
  - [The prompt](#the-prompt)
  - [The repair prompt](#the-repair-prompt)
  - [The fix prompt](#the-fix-prompt)
  - [The rules](#the-rules)
  - [Transcripts](#transcripts)
- [Gates](#gates)
- [Planners](#planners)

## Catalogue

| Slot                          | Kind      | Answers                                                                                    |
| ----------------------------- | --------- | ------------------------------------------------------------------------------------------ |
| `agents/cursor.mjs`           | Agent     | Runs Cursor CLI with a filled prompt                                                       |
| `agents/claude.mjs`           | Agent     | Runs Claude Code with a filled prompt                                                      |
| `builders/producer.mjs`       | Builder   | First pass of a Subtask: fill `{{task}}`, then spawn the agent                             |
| `builders/repair.mjs`         | Builder   | A Gate refused the Subtask: fill `{{task}}` and `{{report}}`                               |
| `assembly/fix.mjs`            | Builder   | A judgement refused the assembled feature: fill `{{task}}` and `{{report}}`                |
| `gates/workspace-changed.mjs` | Gate      | The Attempt left an uncommitted change                                                     |
| `gates/parent-clean.mjs`      | Gate      | Isolator's Parent working files did not move                                               |
| `gates/sensitive-path.mjs`    | Gate      | No path matching a glob was touched                                                        |
| `gates/ci-green.mjs`          | Gate      | The work line's own checks came back green                                                 |
| `planners/one-subtask.mjs`    | Planner   | Bootstrap: one Subtask that is the FeatureStandard itself                                  |
| `publishers/git.mjs`          | Publisher | Pushes the feature's branch to the work line's own remote                                  |
| `refreshers/git.mjs`          | Refresher | Fast-forwards the work line copy onto what the Authority holds                             |
| `planners/producer.mjs`       | Planner   | An agent CLI splits the FeatureStandard                                                    |
| `messages/conventional.mjs`   | Message   | `<type>: <title>` for the feature's fold, no agent; `--scope`, `--type`                    |
| `messages/git-producer.mjs`   | Describer | An agent reads the git diff and writes the feature's subject and body under `--rules-file` |

## Agents

A vendor CLI is not a Builder. `agents/cursor.mjs` and `agents/claude.mjs` take
a prompt that is **already filled**, run the vendor, write a transcript if asked,
and print the serialized run on stdout with `writeContract` (so a large
stream-json transcript survives `process.exit`). They do not know `--intention`
or `--report`. A role slot after `--` is what names one:

```json
"--",
"node", "./node_modules/@bluewombat/slots/agents/cursor.mjs",
"--transcript-dir", "./.mason/transcripts"
```

`cursor.mjs` needs `cursor-agent` on PATH (`cursor-agent login`); `claude.mjs`
needs `claude`, signed in once.

| Option                             | Meaning                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `--prompt TEXT`                    | The filled prompt. Mutually exclusive with `--prompt-file`                       |
| `--prompt-file PATH`               | The same text, from a file. No interpolation                                     |
| `--bin PATH`                       | The CLI to run. Default: the vendor's own name, on PATH                          |
| `--model NAME`                     | Model for that run                                                               |
| `--output-format FMT`              | `stream-json` (default), `json`, or `text`. Skill extraction needs `stream-json` |
| `--permission-mode MODE`           | `claude.mjs` only. Default `bypassPermissions`                                   |
| `--transcript-dir PATH`            | Write one file per turn under here. Off unless given                             |
| `--transcript-part NAME`           | `prompt`, `stdout`, `stderr`, `timing`. Repeatable. Default: all                 |
| `--agent-arg VALUE`                | Appended to the CLI argv, before the prompt. Repeatable                          |
| `--id` / `--attempt` / `--context` | How a transcript is filed. Forwarded by the role                                 |

The agent CLI prints **one JSON line** — a `SerializedRun` from
`@bluewombat/slot-kit` — with the vendor's raw streams plus two extras the
wrapper fills when it can:

| Field    | Meaning                                                                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills` | `null` = unknown (not stream-json, or unparseable). `[]` = looked, none used. Otherwise skill names in order                                         |
| `usage`  | `null` = unknown. Otherwise token counts (`input`, `output`, `cacheRead`, `cacheWrite`) and `costUsd` (`null` when the vendor did not report a cost) |

Cursor extracts skills from `stream-json` `readToolCall` paths ending in
`/skills/<name>/SKILL.md`. Claude extracts them from `tool_use` blocks named
`Skill` (`input.skill`), and adds `--verbose` whenever the format is
`stream-json`. A future vendor agent (`codex.mjs`, …) uses the same fields:
leave them `null` when it cannot tell.

When `--transcript-dir` is set, the transcript header repeats `skills` and
`usage` (`unknown`, `(none)`, or the values).

A global npm install belongs to one Node version: after `nvm use`, a `claude`
installed under another version is off PATH. Give `--bin` the absolute path, or
install it under the version the run uses.

The vendor's output streams to stderr as it comes. A CLI that cannot start,
whose sign-in is gone, or that refuses the invocation is `fail-blocking` once
the role classifies the run — an unusable CLI is not worth another Attempt. The
agent failing at the work is `fail-retryable`. An agent that declines in prose
still exits 0: that is what `workspace-changed` is for.

The outcome is read from the CLI's own result object, not from its `subtype`: a
`claude -p` run whose sign-in had expired reported `"subtype": "success"` beside
`"is_error": true`.

Do not pass `--worktree`: Isolator already isolated the workspace.

## Builders

A role slot fills **its** placeholders and spawns the agent command after `--`.
`--prompt-file` and `--rules-file` belong here. Vendor flags belong after `--`.

`--report` on retry is what chooses `builders/repair.mjs`; the first-pass
producer refuses it.

### The prompt

The shipped prompt speaks to an agent that only knows the directory it woke up
in: it names no part of mason, because none of it is visible from there. What
changes from one Project to the next is that text, not the agent, so it is a
template file on the role:

```json
"builder": {
  "producer": {
    "cmd": [
      "node", "./node_modules/@bluewombat/slots/builders/producer.mjs",
      "--prompt-file", "./mason-prompt.md",
      "--",
      "node", "./node_modules/@bluewombat/slots/agents/cursor.mjs"
    ],
    "timeoutMs": 600000
  }
}
```

A path that names a file next to the config resolves against the config; any
other relative path resolves inside the Subtask workspace, so a template
committed in the Project travels with it.

Each role owns a closed set. An unknown name, or a required name the template
never places, is `fail-blocking`. `{{done_when}}` is `Done when:` plus the
definition of done, and vanishes whole when there is none — which is every
assembly, so `assembly/fix` does not fill it at all.

| Role                | Required                              | Also fills                                                 |
| ------------------- | ------------------------------------- | ---------------------------------------------------------- |
| `builders/producer` | `{{task}}`, `{{rules}}`               | `{{done_when}}`, `{{id}}`, `{{attempt}}`                   |
| `builders/repair`   | `{{task}}`, `{{report}}`, `{{rules}}` | `{{refused_by}}`, `{{done_when}}`, `{{id}}`, `{{attempt}}` |
| `assembly/fix`      | `{{task}}`, `{{report}}`, `{{rules}}` | `{{refused_by}}`, `{{id}}`, `{{attempt}}`                  |

A first-pass command that receives `--report` is `fail-blocking`: that report
belongs to the repair command. A repair or fix command without `--report` is the same.

### The repair prompt

A pass a Gate refused is a different job from a first pass: not "do this" but
"this was refused, resolve it". So it is a different role — `builders/repair.mjs`
— with its own template. The agent after `--` can be the same.

A repair template must place `{{report}}` — one that never says what was wrong is
a run spent on nothing. A command that arrives with a report and no
`--prompt-file` of its own falls back to the shipped repair template.

### The fix prompt

A judgement of the assembled feature that refused it is not a Subtask retry.
The units already passed. `assembly/fix.mjs` tells the agent to change what the
refusal names and leave the rest. Same placeholders as repair except
`{{done_when}}`, which an assembly has nothing to fill.

### The rules

`{{rules}}` holds the bounds of the slot: one directory, work left uncommitted,
nothing pushed. A producing template must place it — one that leaves it out is
`fail-blocking` before any agent runs, naming the file. Without the bounds the
Gates are what says no, which is slower, reaches the tracker, and spends a run.

`--rules-file` replaces them with the Project's own. The last three are not a
matter of taste: the Gates read the working tree of the Subtask directory, so an
agent that commits, stashes or writes elsewhere leaves them nothing to see and
the pass is refused for having done nothing. Replacing the rules does not lift
that; it only stops saying it out loud.

### Transcripts

The journal films the system: which phase ran, what each Gate answered. It
cannot film the turn itself — the prompt and the agent's answer exist nowhere
but inside the slot, and by the time a result reaches Host it is one word. So a
loop that misbehaves cannot be read back, only guessed at.

`--transcript-dir` writes one Markdown file per turn: the invocation, the prompt
as sent, stdout, stderr, how long it took, and — when the agent wrapper passed
them — `skills` and `usage` (`unknown`, `(none)`, or the values). Files are
filed under the Feature the Task belongs to, named for the Subtask and the
Attempt. It belongs on the **agent** command, after `--`.

```json
"builder": {
  "producer": {
    "cmd": [
      "node", "./node_modules/@bluewombat/slots/builders/producer.mjs",
      "--",
      "node", "./node_modules/@bluewombat/slots/agents/cursor.mjs",
      "--transcript-dir", "./.mason/transcripts"
    ],
    "timeoutMs": 600000
  }
}
```

```
.mason/transcripts/github-owner-repo-34/s1-attempt-2-20260908T134501Z.md
```

Off unless the directory is given, and that is not caution for its own sake: a
transcript is the Project's own material — its code, its conventions, its
failures — written to disk in the clear. `--transcript-part` narrows what is
kept; `timing` alone costs nothing and says nothing about the Project. Whatever
directory is chosen belongs in `.gitignore`.

Failing to write a transcript never fails the run: it is a record of the turn,
not part of it.

## Gates

Every Gate answers with one JSON object on stdout — `{"verdict":"pass"}`, or
`fail-retryable` / `fail-blocking` with a `report`. Which sequence a Gate belongs
in, and what mason appends to its argv, is in
[`@bluewombat/runtime`](../../host/runtime/README.md).

```json
"builder": { "gates": {
  "defaultTimeoutMs": 120000,
  "gates": [
    {
      "id": "workspace-changed",
      "argv": ["node", "./node_modules/@bluewombat/slots/gates/workspace-changed.mjs"]
    },
    {
      "id": "parent-clean",
      "argv": ["node", "./node_modules/@bluewombat/slots/gates/parent-clean.mjs"]
    },
    {
      "id": "sensitive-path",
      "argv": [
        "node",
        "./node_modules/@bluewombat/slots/gates/sensitive-path.mjs",
        "**/.env",
        "**/secrets/**"
      ]
    }
  ]
} }
```

`workspace-changed` fail-retries when the workspace has no uncommitted change —
the Attempt produced nothing, or committed and hid it. It takes no option. Put
it first: every Gate after it then judges work that exists. It passes at
`--stage assembly`, where "nothing changed" is a correct outcome rather than a
producer to send back.

`parent-clean` fail-blocks if Isolator's Parent working files changed
(`--parent DIR`, or the other git worktrees of this Child).

`sensitive-path` fail-retries if the workspace changed a path matching a glob.
`*` is one segment, `**` any depth.

`ci-green` reads the work line's own checks on what this workspace published,
and answers on them. It reads and nothing else — it does not push, does not open
a pull request, does not merge. Whoever put the work in front of the checks did
that before the Gate ran; a workspace with nothing published is `fail-blocking`,
because no Attempt of that Task can change it.

```json
"assembly": { "gates": {
  "defaultTimeoutMs": 900000,
  "gates": [
    {
      "id": "ci-green",
      "argv": [
        "node",
        "./node_modules/@bluewombat/slots/gates/ci-green.mjs",
        "--token-env",
        "MASON_GITHUB_TOKEN",
        "--require-checks"
      ]
    }
  ]
} }
```

It waits while checks are running, so give it a ceiling of its own. On a red
check the report carries the failing job's log, cut at the error the runner
marked — a check name and the word "failure" tell the next Attempt nothing it
can act on. Right after a push the checks may not be created yet, and an empty
list reads as a pass: on a repository with CI, give it `--require-checks`, and
it waits for a check to appear instead. `--token-env` is required and names
the variable holding a token that can read the checks — the same one the
manager's `tokenEnv` names. It has no default on purpose: `GITHUB_TOKEN` is
what `gh` reads ahead of its own login, so an operator must not export it,
and a Gate that fell back to it refused only at the first assembly of a real
run. `--remote` and `--poll-ms` are there too. It talks to GitHub, and knows
nothing about `@bluewombat/manager-github`: a Project may run either one
without the other.

`sensitive-path`, `workspace-changed` and `ci-green` need a git workspace, which
is what Isolator makes when WorkLineStable is a git tree. They fail-block on a
workspace Isolator had to copy.

## Planners

`one-subtask.mjs` is the bootstrap Planner: one Subtask that is the
FeatureStandard itself. It is what `mason init` writes into a fresh config, and
it takes no option.

`planners/producer.mjs` hands the split to an agent CLI. It reads the project
before answering and writes nothing into it. `--prompt-file` and `--read` belong
on the role; the vendor is named after `--`, the same way a Builder names it.

```json
"planner": {
  "cmd": [
    "node", "./node_modules/@bluewombat/slots/planners/producer.mjs",
    "--read", "./work-line-stable",
    "--",
    "node", "./node_modules/@bluewombat/slots/agents/cursor.mjs"
  ],
  "timeoutMs": 600000
}
```

| Option               | Meaning                                                       |
| -------------------- | ------------------------------------------------------------- |
| `--read PATH`        | The project the agent may read before splitting. Default: cwd |
| `--prompt-file PATH` | Prompt template. Must place `{{intention}}` and `{{out}}`     |

`--bin`, `--model`, `--transcript-dir` and `--agent-arg` are the agent's, after
`--`. Optional placeholder: `{{max_units}}`.

A Plan it cannot use — a cycle, a dangling dependency, more Subtasks than
`--max-units` — is this slot's own failure: it exits non-zero so the Breakdown is
retried. A FeatureStandard that cannot be split is a refusal on stdout, which
is a verdict on the intention instead.

## Publishers

The slot that puts an assembled feature where the Authority can read it. It runs
**in the work line**, and mason appends `--id`, `--ref` — the name Isolator gave
the feature — and `--target`, the work line it is offered to.

`git.mjs` pushes that name to the work line's own remote. A plain push, no force
of any kind: Integrator only ever adds history, so republishing after a refusal
is a fast-forward. A rejection means the name moved under us, which is the one
case worth refusing rather than overwriting.

It takes no option, and the remote is `origin`. After the Authority folds, Host
reads the work line back from `origin` on its own, with no way to learn what this
slot was told — so a `--remote` here would publish to one place while the refresh
read another. It comes back when that half is a slot too.

The answer is one JSON object on stdout, like every slot:

```json
{ "ref": "issue/feature-42" }
{ "outcome": "refused", "reason": "the remote rejected the push" }
```

The reference is opaque above this line — a branch, a directory, a URL. Whatever
the Publisher answers is what the FeatureManager is told to judge, so a Project
that places its work some other way writes its own Publisher and changes nothing
else. A refusal stops the Submission and travels back to the tracker; a slot that
could not run at all exits non-zero and says why on stderr.

## Refreshers

The other half of the Publisher's seam: what the Authority accepted has moved the
reference work line, and the copy this system works in has not. Left behind, the
next Isolation starts from a version that no longer exists — so this runs before
anything else in a pass. mason appends `--target`.

`git.mjs` fetches that branch from `origin` and fast-forwards onto it. Fast-forward
only: this system never rewrites that line, and a copy that cannot fast-forward has
been written to by somebody else. A plain directory has no reference held anywhere
else, so it answers `ok` with nothing to do.

```json
{ "ok": true }
{ "outcome": "refused", "reason": "<copy> has diverged from origin/main: …\nPut it back with: git -C <copy> reset --hard origin/main\nor delete the directory and start again; it is fetched afresh." }
```

A refusal stops the pass: nothing starts, and the next one tries again. The
reason is written for the person who reads `mason run`'s trace: the copy is the
system's, nothing in it is worth keeping, and the reason says the one command
that puts it back.

## Stack

Plain `.mjs`, run by Node. No build step. Repository stack:
[docs/DEVELOPMENT.md](../../../docs/DEVELOPMENT.md).

## Commands (development)

| Task      | Command          |
| --------- | ---------------- |
| Lint      | `npm run lint`   |
| Format    | `npm run format` |
| Typecheck | `npm run tsc`    |
| Test      | `npm test`       |

Every slot is tested by spawning it, the way mason does — `test/` holds those
suites and `fixtures/` the stand-in agent CLIs they run against.

The slots are plain `.mjs`, so the path in a Project config is the file in this
repository and nothing is built. `tsc` still checks them: `checkJs` reads the
kit's types through the imports, and a helper that takes an argument names its
type in JSDoc.

## Layout

```
README.md      this file
agents/        vendor CLIs: filled prompt in, serialized run out
builders/      first-pass and repair roles for a Subtask
assembly/      the same two roles for the assembled feature
lib/           what the shipped templates say, shared by the roles
gates/         checks on the workspace, and on the work line
planners/      FeatureStandard in, a Plan out
messages/      what a commit says: a rule, or an agent under the team's guideline
test/          one suite per kind; each spawns the real command
fixtures/      fake agent CLIs the Builder and Planner suites run against
```
