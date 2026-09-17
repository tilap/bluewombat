# Manager kit

A contract, not a Transformer. It holds no behaviour: it is the type boundary
between Host and one FeatureManager, so a third party can write a tracker
integration without depending on Host and without Host depending on them.

## 1. Job

```
  Host                          manager-kit                        a manager package
  ----                          --------                        -----------------
  reads a specifier             ManagerPort                     implements createManager
  hands over managerOptions     ManagerContext                  reads its own options
  asks doctor for findings      Finding                         may implement checkManager
  asks init for a scaffold      ManagerScaffold                 may implement scaffoldManager
  asks init its questions       ManagerQuestion                 may implement questionsManager
  asks setup for a plan         SetupStep                       may implement setupManager
  asks where the reference is   Record<string, unknown>         may implement referenceManager
                            ←   nothing at runtime
```

**In:** nothing. **Out:** types, and five pure option readers.

## 2. The Port

| Member         | Required | Job                                                                                                                                          |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `listen`       | yes      | Drain the tracker since a Cursor. Returns an outcome and ordered Deliveries                                                                  |
| `adapt`        | yes      | One raw payload → a FeatureStandard, or `invalid` / `unavailable` / `interrupted`                                                            |
| `report`       | yes      | One semantic Event onto the tracker. `false` when it could not be written                                                                    |
| `signalsReady` | no       | Whether this payload says a human unblocked an escalated Feature (a label, a status)                                                         |
| `clearReady`   | no       | Take that signal back once it has been acted on. Left in place it resumes the Feature again on every pass, and an escalation freezes nothing |
| `submit`       | no       | Offer an assembled feature to the Authority. Returns an opaque reference                                                                     |
| `fold`         | no       | Have the Authority take an accepted Submission into the work line                                                                            |
| `probe`        | no       | Whether the intention this key named is still on the tracker (`present` / `gone` / `unavailable` / `interrupted`)                            |

The two Authority methods, `submit` and `fold`, come as a set. A manager that declares none has no
Authority, and an assembled feature is folded into WorkLineStable directly — the
way it was before any of this existed. `report` may carry an `eventId`: an Event
that states a fact rather than a change is written once, however many passes see
it.

`probe` exists because a poll cannot see an absence: a deleted item is missing
from every later page and never becomes a Delivery. Host already holds the keys.
`gone` is abandon, the same intent as a `cancel` delivery. `unavailable` is not
abandon — a missed read must not cancel work. Host only calls `probe` after a
listen that reached the source, so a token that can no longer list the tracker
is not read as every Feature disappearing. A manager that cannot answer omits
the method; Host does not invent an absence.

Host never reads a payload itself. A tracker's issue number, label, or status
is recoverable from the `key` the manager minted, so nothing tracker-shaped
crosses the Port.

## 3. The module

`createManager(context)` returns `{ ok: true, manager }` or `{ ok: false, reason }`.
It must not throw for a bad option: the reason is what the user reads.

| Context field   | Content                                                |
| --------------- | ------------------------------------------------------ |
| `options`       | The config's `managerOptions`, unread by Host          |
| `durationMs`    | Wall clock every call of this manager must stay inside |
| `interruptFlag` | Flips on SIGINT / SIGTERM; long calls must stop        |
| `configDir`     | Directory a relative option path resolves against      |
| `env`           | Where a secret named by an option is read from         |

A secret is read by the manager, from `context.env`, never by Host and never
from the config file.

`checkManager(context)` is optional and returns `Finding[]`. `ok`, `warn`,
`fail`; only `fail` makes `mason doctor` exit non-zero. It must answer the
same offline as online.

`questionsManager(context)` is optional and returns `ManagerQuestion[]`: the
wording, the fallback, and the validation of each `managerOptions` key a human
should be asked for. It declares them — Host reads the terminal, so no manager
ever touches stdin. A question whose key already has a value is skipped.

`referenceManager(context)` is optional and returns where the Authority keeps
the reference work line, or `undefined`. Host does not read it: the Isolation
strategy named by `workLine.isolation` does, strictly, and refuses a key it does
not know before a run writes anything. Only a manager that also declares
`submit` and `fold` has a reference to name — with no Authority the work line is
the operator's directory, whatever this returns. Offline.

`setupManager(context, { apply })` is optional and is the **only hook allowed
to reach the tracker over the network and to write to it**. The hooks form one
progression:

| Hook               | Command                       | Network | Writes                                           |
| ------------------ | ----------------------------- | ------- | ------------------------------------------------ |
| `questionsManager` | `mason init`                  | no      | nothing — it only declares                       |
| `scaffoldManager`  | `mason init`                  | no      | the local config file                            |
| `referenceManager` | `mason init`, `doctor`, `run` | no      | nothing — the strategy fetches the copy on `run` |
| `checkManager`     | `mason doctor`                | no      | nothing                                          |
| `setupManager`     | `mason setup`                 | yes     | the tracker, on `--apply`                        |
| `createManager`    | `mason run`                   | yes     | the tracker                                      |

With `apply` false it reports a plan and changes nothing: a step is `satisfied`
or `missing`. With `apply` true a step it fixed is `applied`. A step nothing
here can fix is `blocked`, and `ok` is false. It must be idempotent — a second
call with `apply` true reports everything `satisfied` and writes nothing.

`scaffoldManager(context)` is optional and returns `{ options, nextSteps, prepare? }`.
`mason init` copies `options` into `managerOptions` (flag `--manager-option`
wins per key), prints `nextSteps`, and calls `prepare(cwd)` so a directory
Source can exist before the first run. Host does not grow a flag for a
tracker's fields.

## 4. Option readers

`stringOption`, `stringArrayOption`, `intOption`, `booleanOption`,
`rejectUnknownOptions`. Values arrive either from JSON (already typed) or from
repeated `--manager-option key=value` flags (always strings), so every reader
accepts the string spelling of its type, and a repeated flag key arrives as an
array.

`rejectUnknownOptions` exists because a silently ignored typo leaves a manager
running with a default the user thought they had changed.

## 5. Acceptance

1. A module exporting only `createManager` loads and drives a full run.
2. A reader given the string spelling of a number or a boolean returns the value.
3. A misspelled option key is refused, and the message lists the known keys.
4. `EVENT_NAMES` is the same list as the `EventName` union, at runtime.
5. `probe` is optional. `gone` is abandon; `unavailable` is not.

How to build and write a manager: [README.md](./README.md).
