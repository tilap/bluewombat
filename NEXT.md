# Next

Ideas to do later. Not in force.

## `mason doctor` is a status list; `mason doctor inspect` shows the values

`npx mason doctor` today prints one long line per check, with the resolved
value on the same line (paths, argv, tokens names, gate globs). A healthy run
is hard to scan: every line says `ok`, and the thing that would say `ko` is
buried in the same shape.

`mason doctor` should print one short line per check: the check's name and
`ok` or `ko`, nothing else. A failure still names which check failed, so the
eye can find it. It does not print paths, argv, or other resolved values.

`mason doctor inspect` prints what `doctor` prints today: each check, its
state, and the value that was judged.

Where: `packages/host/runtime/src/operator/doctor.ts`.

## `mason start`, `mason stop`, `mason status` — the everyday verbs

Today the process that stays up and polls is `mason run`. Beside it, `status`
already exists: it prints a ledger snapshot and exits. `watch` is that
snapshot, then it follows the journal.

The everyday surface should be three verbs with one meaning each:

- `mason start` — the process is up (what `mason run` does now, as something
  you leave running).
- `mason stop` — that process is down.
- `mason status` — is it up or down, in one glance.

`status` is the open question. The name is already taken by the ledger
snapshot. A later pass has to decide what the short status says, what happens
to the current snapshot (`status` as it is, `watch`, or another name), and
whether `run` stays as the foreground form of `start`. Do not rename in
passing: the point is one coherent set, not a second word for the same
command.

Where: `packages/host/runtime/src/cli.ts`.

## `mason version`

`mason run` prints nothing while it is idle. A quiet tick is written to the
journal and not to the terminal, so a live process looks like it never
started. The version is already recorded, only on the `host-started` line of
`.mason/ledger/events.jsonl` (`version`, `pid`). There is no command that
prints it.

`mason version` prints the version of the `mason` binary that answered, then
exits. That is the package version of `@bluewombat/runtime` for that binary —
the one `npx` resolved in this directory, not a guess from `package.json`.

Where: `packages/host/runtime/src/cli.ts`. `hostVersion` in
`packages/host/runtime/src/loop/open-host.ts` already reads that manifest for
the journal.

## Every command prints something

Silence is not an answer. Whatever the command — `run`, `version`, `doctor`,
`status`, the rest — it prints at least one line before it settles into
waiting, or as it exits. A terminal that stays empty means the process did
not start, not that everything is fine.

`mason run` is the case that hurts: an idle process writes `idle` to the
journal and nothing to the terminal. The first line should say that it is up,
which binary, and that it is waiting. Later quiet ticks can stay quiet. The
absence of that first line is what reads as "nothing is happening".
