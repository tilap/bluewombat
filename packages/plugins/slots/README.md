# Slots

The Builder, Gate, and publishing commands that ship with mason. A Project points
its config at one of these paths; nothing here is imported.

```yaml
builder:
  producer:
    cmd:
      - node
      - ./node_modules/@bluewombat/slots/builders/producer.mjs
      - --prompt-file
      - ./build.md
      - --
      - node
      - ./node_modules/@bluewombat/slots/agents/claude.mjs
    timeoutMs: 600000
  repair:
    cmd:
      - node
      - ./node_modules/@bluewombat/slots/builders/repair.mjs
      - --prompt-file
      - ./repair.md
      - --
      - node
      - ./node_modules/@bluewombat/slots/agents/claude.mjs
    timeoutMs: 600000
  gates:
    defaultTimeoutMs: 120000
    gates:
      - id: workspace-changed
        argv: [node, ./node_modules/@bluewombat/slots/gates/workspace-changed.mjs]
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

## Catalogue

| Slot                          | Kind      | Answers                                                                                    |
| ----------------------------- | --------- | ------------------------------------------------------------------------------------------ |
| `agents/cursor.mjs`           | Agent     | Runs Cursor CLI with a filled prompt                                                       |
| `agents/claude.mjs`           | Agent     | Runs Claude Code with a filled prompt                                                      |
| `builders/tests.mjs`          | Builder   | The tests of the task, written before its code: one test per case of its "Tests" section, stubs for a missing interface, tests that fail now. |
| `builders/producer.mjs`       | Builder   | First pass of the unit of work: fill `{{task}}`, then spawn the agent                             |
| `builders/repair.mjs`         | Builder   | A Gate refused the unit: fill `{{task}}` and `{{report}}`                               |
| `ticket/fix.mjs`              | Builder   | A judgement refused the assembled ticket: fill `{{task}}` and `{{report}}`              |
| `feature/validate.mjs`        | Builder   | Read-only review of the whole feature against its request: fill `{{task}}`; same verdict line as `ticket/validate.mjs` |
| `feature/fix.mjs`             | Builder   | A judgement refused the whole feature: fill `{{task}}` and `{{report}}`                 |
| `ticket/validate.mjs`         | Builder   | Read-only review of the assembled work: fill `{{task}}`; answers `MASON_VERDICT: VALIDATED` or `MASON_VERDICT: REFUSED: …` |
| `gates/workspace-changed.mjs` | Gate      | The Attempt left an uncommitted change                                                     |
| `gates/parent-clean.mjs`      | Gate      | Isolator's Parent working files did not move                                               |
| `gates/sensitive-path.mjs`    | Gate      | No path matching a glob was touched                                                        |
| `gates/workspace-unchanged.mjs` | Gate    | A read-only pass changed nothing at all (a file modified, deleted or added)                |
| `gates/gitignore-leak.mjs`    | Gate      | The ticket's commits add nothing its own `.gitignore` excludes                            |
| `gates/project-checks.mjs`    | Gate      | One command of the Project's own (typecheck, tests, lint, build) exits 0 in the workspace  |
| `gates/tests-red.mjs`         | Gate      | The tests just written fail, and not on a missing import or a syntax error (`--cmd` with `{files}`, `--test-glob`, `--not-red-when`). |
| `gates/tests-frozen.mjs`      | Gate      | A test file held by the "Tests: " checkpoint was not modified, deleted or renamed (`--test-glob`, `--subject-prefix`) |
| `gates/ci-green.mjs`          | Gate      | The work line's own checks came back green                                                 |
| `publishers/git.mjs`          | Publisher | Pushes the ticket's branch to the work line's own remote                                  |
| `refreshers/git.mjs`          | Refresher | Fast-forwards the work line copy onto what the Authority holds                             |
| `messages/conventional.mjs`   | Message   | `<type>: <title>` for the ticket's fold, no agent; `--scope`, `--type`                    |
| `messages/git-producer.mjs`   | Describer | An agent reads the git diff and writes the ticket's subject and body under `--rules-file` |

## Agents

A vendor CLI is not a Builder. `agents/cursor.mjs` and `agents/claude.mjs` take
a prompt that is **already filled**, run the vendor, write a transcript if asked,
and print the serialized run on stdout with `writeContract` (so a large
stream-json transcript survives `process.exit`). They do not know `--intention`
or `--report`. A role slot after `--` is what names one:

```yaml
- --
- node
- ./node_modules/@bluewombat/slots/agents/cursor.mjs
- --transcript-dir
- ./.mason/transcripts
```

`cursor.mjs` needs `cursor-agent` on PATH. Without `--agent-home` it uses the
CLI's own login (`cursor-agent login`). With `--agent-home DIR` and
`--api-key-env NAME` the vendor process gets that directory as `HOME` and
`CURSOR_API_KEY` from `NAME`; the value never appears on the argv. It also gets
a short environment (`PATH`, locale, proxy and certificate variables and a few
others, plus the names given with `--pass-env`), not the operator's whole
shell; git's credential helpers are cleared for it; and `ssh`, `scp` plus the
commands given with `--deny-shell` are denied in its own `cli-config.json`,
rewritten every run. That
lowers a risk and confines nothing (RESERVATIONS F32). `claude.mjs`
needs `claude`, signed in once, and refuses those two flags: Claude is not
isolated yet, and starting it would keep the operator's own config.

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
| `--agent-home DIR`                 | Isolate the vendor process: its `HOME` is this directory. Cursor only; Claude refuses |
| `--api-key-env NAME`               | With `--agent-home`, read `process.env[NAME]` for the vendor key. Never the value itself |
| `--pass-env NAME`                  | With `--agent-home`, also hand the vendor this environment variable. Repeatable |
| `--deny-shell NAME`                | With `--agent-home`, also refuse this command to the vendor (`gh`, `vercel`…). `ssh` and `scp` always are. Repeatable |
| `--plugin-dir DIR`                 | A plugin folder of the operator's (a Mason home's `ai-plugins/core/*`). Repeatable, loaded first |
| `--app-deck-profile PATH`          | The app's deck profile for this role, as a path in the checkout: `[<app dir>/].ai/profiles/<name>`. Cursor only; Claude refuses |
| `--plugins-out DIR`                | Where the profile is built, one folder per profile. Required with `--app-deck-profile`; never the workspace |
| `--deck-bin PATH`                  | The deck CLI. Default: the `@pinkpuma/deck` this package depends on |
| `--id` / `--attempt` / `--context` | How a transcript is filed. Forwarded by the role                                 |

### Plugins

An agent starts with plugin folders, each passed to the vendor as
`--plugin-dir`: first the `--plugin-dir` folders, in order, then what the
project's [deck](https://github.com/tilap/pinkpuma-deck) profile resolves to.

`--app-deck-profile .ai/profiles/builder` runs `deck materialize -C <app dir> --profile builder --out
<plugins-out>/builder --json` before the vendor starts. The working directory
is the checkout the agent works on, so a role gets what the project committed
at that commit — the base `ai-plugin.json` and `.ai/profiles/builder/`, as their
locks pin them — never what the operator has installed. deck refuses a request
no committed lock pins, and the wrapper then refuses before the vendor starts
(`Run deck install in the project and commit its locks`). Every Attempt of the
role refuses the same way until the project is fixed; `mason doctor` says so
first.

| The project has                         | The agent gets                       |
| --------------------------------------- | ------------------------------------ |
| `.ai/profiles/<name>/ai-plugin.json`    | the base and that profile            |
| only a base `ai-plugin.json`            | the base, and a note on stderr       |
| no deck file at all                     | the `--plugin-dir` folders only      |

A non-empty `.ai/profiles/<name>/prompt.md` is appended to the filled prompt
under `## Project instructions for this role`: what the project wants from that
role, next to what Mason asks.

The plugins keep their hooks: deck writes a plugin's `hooks/hooks.json` as its
author did. `cursor-agent` ran a Claude-format one (`${CLAUDE_PLUGIN_ROOT}`,
`PostToolUse` on edits) on a real run; a hook that runs is part of the agent's
time and of what it reads back.

deck's cache (`~/.cache/pinkpuma-deck`, or `DECK_CACHE`) has no lock, and
`--plugins-out` holds one folder per profile: both rely on a Mason run starting
one agent at a time, which it does.

`claude.mjs` takes `--plugin-dir` but refuses `--app-deck-profile`: not isolated, Claude
also loads the operator's plugins and the project's `.claude/settings.json`, so
a role's profile would not be all it gets.

The agent CLI prints **one JSON line** — a `SerializedRun` from
`@bluewombat/slot-kit` — with the vendor's raw streams plus the extras the
wrapper fills when it can:

| Field    | Meaning                                                                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills` | `null` = unknown (not stream-json, or unparseable). `[]` = looked, none used. Otherwise skill names in order                                         |
| `usage`  | `null` = unknown. Otherwise token counts (`input`, `output`, `cacheRead`, `cacheWrite`) and `costUsd` (`null` when the vendor did not report a cost) |
| `plugins` | Absent when no plugin folder was loaded. Otherwise each folder: `id`, `path`, `from` (`local` or `deck`), and `integrity` (deck's, `null` for a local one) |
| `tools`  | `null` = unknown (not stream-json, or unparseable). Otherwise what the agent did with its tools: `calls` per tool name, `busyMs` (time with a tool running; `null` when the stream has no times, as Claude's), and the lists `web` (pages fetched, searches, URLs a shell command named), `mcp` (`server/tool`, plus `getMcpTools` when the agent only listed a server's tools), `subagents` (by description), `outside` (paths named outside the working directory, skill files excepted) |

Cursor extracts skills from `stream-json` `readToolCall` paths ending in
`/skills/<name>/SKILL.md`. Claude extracts them from `tool_use` blocks named
`Skill` (`input.skill`), and adds `--verbose` whenever the format is
`stream-json`. Tools come from Cursor's `<name>ToolCall` events (`webFetch`,
`mcp`, `task`, `shell`, … — names seen on cursor-agent 2026.10.01) and from
Claude's `tool_use` blocks (`WebFetch`, `WebSearch`, `Bash`, `Task`,
`mcp__<server>__<tool>`); the vendor-free part is `agents/tool-facts.mjs`. A
future vendor agent (`codex.mjs`, …) uses the same fields: leave them `null`
when it cannot tell.

When `--transcript-dir` is set, the transcript header lists the `plugins` and
repeats `skills`, `usage` and the tools — `tools`, `web`, `mcp`, `subagents`, `outside the
workspace` — each `unknown`, `(none)`, or the values. "Did it read the page I
linked?" is answered there, without reading the stream.

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

```yaml
builder:
  producer:
    cmd:
      - node
      - ./node_modules/@bluewombat/slots/builders/producer.mjs
      - --prompt-file
      - ./mason-prompt.md
      - --
      - node
      - ./node_modules/@bluewombat/slots/agents/cursor.mjs
    timeoutMs: 600000
```

A path that names a file next to the config resolves against the config; any
other relative path resolves inside the workspace, so a template
committed in the Project travels with it.

Each role owns a closed set. An unknown name, or a required name the template
never places, is `fail-blocking`.

| Role                | Required                              | Also fills                                                 |
| ------------------- | ------------------------------------- | ---------------------------------------------------------- |
| `builders/producer` | `{{task}}`, `{{rules}}`               | `{{history}}`, `{{id}}`, `{{attempt}}`                     |
| `builders/repair`   | `{{task}}`, `{{report}}`, `{{rules}}` | `{{history}}`, `{{refused_by}}`, `{{id}}`, `{{attempt}}`    |
| `ticket/fix`        | `{{task}}`, `{{report}}`, `{{rules}}` | `{{history}}`, `{{refused_by}}`, `{{id}}`, `{{attempt}}`   |
| `feature/validate`  | `{{task}}`, `{{rules}}`               | `{{id}}`, `{{attempt}}`                                    |
| `feature/fix`       | `{{task}}`, `{{report}}`, `{{rules}}` | `{{history}}`, `{{refused_by}}`, `{{id}}`, `{{attempt}}`   |
| `ticket/validate`   | `{{task}}`, `{{rules}}`               | `{{id}}`, `{{attempt}}`                                    |

A first-pass command that receives `--report` is `fail-blocking`: that report
belongs to the repair command. A repair or fix command without `--report` is the same.

`{{history}}` is what the Task went through before this Attempt, oldest first (the
refusal it came with, each Attempt, each Gate's answer; see Implementer's SPECS §
History). It is empty on a first Attempt and vanishes whole then, so a template
that does not place it simply omits it.

### The way out

Every shipped producer prompt ends with the same exit: when what the agent was
given is not enough to act on, it changes nothing and ends its final message with
one line, `MASON_BLOCKED: <what is missing>`. The slot reads the last such line
in the agent's final message, and answers `fail-blocking` with that reason, so the
Task stops as `escalated` and a person reads it instead of another Attempt
inventing a change. This is the same kind of signal as `ticket/validate`'s
`MASON_VERDICT:` line, and it is not tied to any refuser. A clean exit prints
`{ "said": "<the agent's final message, clipped>" }` on stdout, which the Task
keeps for its History. A Project's own template should keep a paragraph that
tells the agent about the line, or the agent has no way to use it.

### The repair prompt

A pass a Gate refused is a different job from a first pass: not "do this" but
"this was refused, resolve it". So it is a different role — `builders/repair.mjs`
— with its own template. The agent after `--` can be the same.

A repair template must place `{{report}}` — one that never says what was wrong is
a run spent on nothing. A command that arrives with a report and no
`--prompt-file` of its own falls back to the shipped repair template.

### The fix prompt

A judgement of the assembled work that refused it is not a retry of the unit.
The unit already passed. `ticket/fix.mjs` tells the agent to change what the
refusal names and leave the rest. Same placeholders as repair.

### The validate prompt

`ticket/validate.mjs` is a different kind of Builder: it never writes. It
fills only `{{task}}` and `{{rules}}` — there is nothing to fix yet, so no
`{{report}}` — and asks the agent to end its final message with one line:
`MASON_VERDICT: VALIDATED` or `MASON_VERDICT: REFUSED: <one paragraph>`. Its
own `{{rules}}` default is not `PROMPT_RULES`: a review has no work to leave
uncommitted and nothing to push, so it says "read-only" instead of "do not
commit, do not push".

The slot does not trust the CLI's exit code alone — a review can complete
cleanly and still find a problem. It reads the agent's own final answer
(`readResult(run.stdout)?.result`) for the **last** line starting with
`MASON_VERDICT:` — not a bare search for "VALIDATED" or "REFUSED" anywhere in
the text, which a model's own reasoning can contain by accident ("the units
were already validated on their own"). It maps a `REFUSED:` verdict through
`emitFailure("fail-retryable", …)` itself, the report being what followed
`REFUSED:` on that line. No `MASON_VERDICT:` line, or one that is neither
form, is treated the same way, naming what the agent said: a review that did
not answer as asked is not a silent pass.

### The rules

`{{rules}}` holds the bounds of the slot: one directory, work left uncommitted,
nothing pushed. A producing template must place it — one that leaves it out is
`fail-blocking` before any agent runs, naming the file. Without the bounds the
Gates are what says no, which is slower, reaches the tracker, and spends a run.

`--rules-file` replaces them with the Project's own. The last three are not a
matter of taste: the Gates read the working tree of the workspace, so an
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
them — `skills`, `usage` and what the tools did (`unknown`, `(none)`, or the
values). Files are
filed under the Ticket the Task belongs to, named for the Subtask and the
Attempt. It belongs on the **agent** command, after `--`.

```yaml
builder:
  producer:
    cmd:
      - node
      - ./node_modules/@bluewombat/slots/builders/producer.mjs
      - --
      - node
      - ./node_modules/@bluewombat/slots/agents/cursor.mjs
      - --transcript-dir
      - ./.mason/transcripts
    timeoutMs: 600000
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

```yaml
builder:
  gates:
    defaultTimeoutMs: 120000
    gates:
      - id: workspace-changed
        argv: [node, ./node_modules/@bluewombat/slots/gates/workspace-changed.mjs]
      - id: parent-clean
        argv: [node, ./node_modules/@bluewombat/slots/gates/parent-clean.mjs]
      - id: sensitive-path
        argv:
          - node
          - ./node_modules/@bluewombat/slots/gates/sensitive-path.mjs
          - "**/.env"
          - "**/secrets/**"
```

`workspace-changed` fail-retries when the workspace has no uncommitted change —
the Attempt produced nothing, or committed and hid it. It takes no option. Put
it first: every Gate after it then judges work that exists. It passes at
`--stage ticket` (or `feature`), where "nothing changed" is a correct outcome rather than a
producer to send back.

`parent-clean` fail-blocks if Isolator's Parent working files changed
(`--parent DIR`, or the other git worktrees of this Child).

`sensitive-path` fail-retries if the workspace changed a path matching a glob.
`*` is one segment, `**` any depth. It looks at what a fold can carry out of
the workspace — tracked paths, and new ones `.gitignore` does not exclude — so
what an install left under an ignored directory (a dependency's own `.github/`)
is not a change to guard.

`project-checks --cmd COMMAND` runs one command of the Project's own in the workspace
and answers on its exit code. It is the Gate that makes a machine, not the Builder,
say that the code typechecks and the tests pass. The command goes through the shell,
so it is written as the Project writes it; it knows no stack.
The report carries the end of the output, cleaned as it arrives: escape codes removed, a line redrawn with `\r` reduced to its last state, and spinner or progress lines (`[⣷] Pulling schema...`) dropped, so thousands of redraws cannot push the real error out of the tail. `tests-red` reads its output the same way.

```yaml
- id: typecheck
  timeoutMs: 300000
  argv: [node, ./node_modules/@bluewombat/slots/gates/project-checks.mjs, --cmd, "pnpm typecheck"]
- id: tests
  timeoutMs: 600000
  argv: [node, ./node_modules/@bluewombat/slots/gates/project-checks.mjs, --cmd, "pnpm test"]
```

One command per entry: the report then names the check that failed, and the first red
one stops the sequence before a slower one starts. Put the cheap ones first.

- `0` passes.
- A non-zero exit is `fail-retryable`: the producer gets the end of the output
  (the last ~12 KB, where the error is), not the start.
- Exit 126 or 127 (the shell cannot find or run the command) is `fail-blocking`: no
  change to the work fixes it.
- A run that outlives the Gate's ceiling is stopped, with its whole process group, a few
  seconds before the ceiling (`--timeout-ms`, which Implementer passes), and is
  `fail-blocking` too. A hung check and a ceiling that is too short look the same from
  here, so a person decides. Give a test suite a `timeoutMs` of its own.
- It sets `CI=true` so a watcher does not wait for a terminal.
- It runs at both stages. In `ticket.gates` it is the local answer on the assembled
  ticket, so a Project with no CI of its own is still judged by a machine, and one with
  CI gets the answer before waiting for it.

The workspace needs its dependencies, which `workLine.warm` installs once on the Feature.

`workspace-unchanged` fail-blocks when the workspace holds any change: a file modified,
deleted, or added that `.gitignore` does not exclude. It is for a pass that must not
write (`ticket.validate`), whose other Gates each look at a part: `sensitive-path` at
some globs, `parent-clean` at the Parent. It is meant to run where everything is
committed (after the align), so whatever git shows was written since. `--allow GLOB`,
repeatable, lets a path through: use it for what an earlier check leaves behind and the
Project does not ignore (a coverage report). Blocking, not retryable: what the pass
wrote would be committed by the next align, so a person looks.

`gitignore-leak --base REF` fail-retries if the ticket's commits add a path the
workspace's own `.gitignore` excludes — a Builder's `node_modules/`, a build's
`dist/`, a generated file. `REF` is the work line the ticket is offered to
(`main`): only what the ticket adds since it left that line is judged, and
only what is committed, so a path tracked on purpose before the ticket began
is not blamed on it, and a removal staged but not committed does not pass. The
report is written for `ticket.fix`: untrack the paths, or change `.gitignore`
if tracking one is the point. It passes at `--stage unit`, where no commit
holds a the unit's work yet.

It is a second line, not the first: the `isolation-git` fold already keeps an
ignored path out of the commits it makes. It catches a leak that came some
other way — another isolation strategy, an agent that committed. Like every
assembly Gate, with an Authority it judges what was published, so it stops the
fold into the work line, not the push.

```yaml
ticket:
  gates:
    defaultTimeoutMs: 900000
    gates:
      - id: gitignore-leak
        argv: [node, ./node_modules/@bluewombat/slots/gates/gitignore-leak.mjs, --base, main]
      - id: ci-green
        argv:
          - node
          - ./node_modules/@bluewombat/slots/gates/ci-green.mjs
          - --token-env
          - MASON_GITHUB_TOKEN
          - --require-checks
```

`ci-green` reads the work line's own checks on what this workspace published,
and answers on them: GitHub Actions' check runs and the commit statuses a CI
outside Actions reports (Vercel, Netlify, Jenkins…) — the two lists GitHub
shows on a pull request. A pending status is still running; a failed one's
report is its context, what it said, and its link. It reads and nothing else —
it does not push, does not open a pull request, does not merge. Whoever put
the work in front of the checks did that before the Gate ran; a workspace
with nothing published is `fail-blocking`, because no Attempt of that Task
can change it.

It waits while checks are running, so give it a ceiling of its own (the Gate's `timeoutMs`, which Implementer passes to it as `--timeout-ms`). A CI that does not answer is not a refusal of the work: a Gate killed by its clock reads as one, and a refusal sends the work to a producer with nothing to fix. So a few seconds before the ceiling, with no check yet or checks still running, `ci-green` answers `fail-blocking` itself, saying what it was waiting for and for how long, and a person reads it. A check that failed still refuses at once, with its reason. On a red
check the report carries the failing job's log, cut at the error the runner
marked — a check name and the word "failure" tell the next Attempt nothing it
can act on. Right after a push the checks may not be created yet, and an empty
list reads as a pass: on a repository with CI, give it `--require-checks`, and
it waits for a check to appear instead. `--token-env` is required and names
the variable holding a token that can read the checks — the same one the
manager's `tokenEnv` names. It has no default on purpose: `GITHUB_TOKEN` is
what `gh` reads ahead of its own login, so an operator must not export it,
and a Gate that fell back to it refused only at the first assembly of a real
run. `--remote`, `--poll-ms` and `--api-base` (GitHub Enterprise) are there too. It talks to GitHub, and knows
nothing about `@bluewombat/manager-github`: a Project may run either one
without the other.

`sensitive-path`, `workspace-changed`, `gitignore-leak` and `ci-green` need a git workspace, which
is what Isolator makes when WorkLineStable is a git tree. They fail-block on a
workspace Isolator had to copy.

## Publishers

The slot that puts an assembled ticket where the Authority can read it. It runs
**in the work line**, and mason appends `--id`, `--ref` — the name Isolator gave
the ticket — and `--target`, the work line it is offered to.

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
{ "ref": "issue/ticket-42" }
{ "outcome": "refused", "reason": "the remote rejected the push" }
```

The reference is opaque above this line — a branch, a directory, a URL. Whatever
the Publisher answers is what the TicketTracker is told to judge, so a Project
that places its work some other way writes its own Publisher and changes nothing
else. A refusal stops the Submission and travels back to the tracker; a slot that
could not run at all exits non-zero and says why on stderr.

`git.mjs` runs git with `LC_ALL=C`: the refusal quotes git, and it is posted on a
tracker a team reads, whatever language the machine that ran it speaks.

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
that puts it back. Git runs with `LC_ALL=C` here too, for the same reason as the
Publisher.

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
builders/      first-pass and repair roles for the unit of work
ticket/        fix and validate for an assembled ticket
feature/       fix for a whole feature
lib/           what the shipped templates say, shared by the roles
gates/         checks on the workspace, and on the work line
messages/      what a commit says: a rule, or an agent under the team's guideline
test/          one suite per kind; each spawns the real command
fixtures/      fake agent CLIs the Builder suites run against
```
