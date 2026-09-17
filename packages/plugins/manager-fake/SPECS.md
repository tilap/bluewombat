# Manager: fake

A plugin, not a Transformer. Directory Source in, directory Thread out, as
one `ManagerPort`. Listen / adapt / report live in this package.

## 1. Job

```
  Host                          manager-fake
  ----                          ------------
  managerOptions                read source / target
  a Cursor                      drain the directory
  one semantic Event            append to the Thread
                            ←   ManagerPort
```

**In:** a `ManagerContext`. **Out:** a `ManagerPort`, or a reason.

## 2. Options

Relative paths resolve against the config file's directory, so a checked-in
example needs no absolute path.

| Option            | Rule                                                              |
| ----------------- | ----------------------------------------------------------------- |
| `source`          | Required. Must already exist as a directory — this package never creates it |
| `target`          | Required. Created at `createManager` time if absent               |
| `defaultPriority` | Integer 0…100. Default 50                                        |

An unknown option key is refused by name.

## 3. Keys

`fake:<id>` from the raw intention's `id`, or `fake:unconvertible` when it has
none. The project is the payload's `project`, or `unknown`.

## 4. Ready

This manager has no ready signal: a directory Source delivers a `ready` file as
its own intention, so `signalsReady` is absent and Host uses the
FeatureStandard's `intent`.

## 5. Doctor

`checkManager` reports the Source (`fail` when it is not a directory) and the
Thread directory (`warn` when it does not exist yet — the run creates it). No
network, ever.

## 6. Init

`scaffoldManager` writes the default `source` / `target` paths and creates
those directories so the first JSON file has somewhere to go. `createManager`
still refuses a missing Source: prepare is an init convenience, not a silent
create at run time.

## 7. Acceptance

1. Relative `source` and `target` resolve against the config file, and the
   Thread directory exists after `createManager`.
2. A missing `source` directory, a missing required option, and an unknown
   option key each return a reason, not a throw.
3. `checkManager` with unreadable options returns exactly one `fail`.
4. `scaffoldManager` creates the default Source and Thread directories.

How to build and configure: [README.md](./README.md).
