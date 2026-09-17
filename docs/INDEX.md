# Documentation index

Start here. Pick the one or two documents that answer your question, then open
only those. Each document's `covers` front matter names the files it describes:
a change to those files is a change to that document.

## The product

| Document                   | Answers                                                                        |
| -------------------------- | ------------------------------------------------------------------------------ |
| [PRODUCT.md](./PRODUCT.md) | What mason does, its rules, the human surface, and the words the code must use |

## How it is built

| Document                                         | Answers                                                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| [ARCHITECTURE.md](./ARCHITECTURE.md)             | The map, the six words of the build (Transformer, Port, Plugin, Slot, Backend, Kit), what may import what, and where a new piece goes |
| [FOR_DUMMIES.md](./FOR_DUMMIES.md)               | Plain explanations of pieces that are easy to get wrong — git branches, worktrees, the PR path                                        |
| [`../packages/README.md`](../packages/README.md) | The groups, their rules, and the scripts that enforce them; each group has its own README                                             |

## What was settled, and what was not

| Document                             | Answers                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| [DECISIONS.md](./DECISIONS.md)       | The rules in force, why each holds, and what was turned down                                   |
| [RESERVATIONS.md](./RESERVATIONS.md) | Calls nobody validated, defects left in place, code never run for real, things left improvable |

## Working here

| Document                           | Answers                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | The toolchain — Node 24.20, Biome, node:test, Turborepo — and the everyday commands |
| [TESTING.md](./TESTING.md)         | Where tests live, how `npm test` runs them, and what no suite proves                |
| [RUNBOOKS.md](./RUNBOOKS.md)       | Pause, emergency stop, escalation, and how a release is cut                         |

A package's own README and SPECS say how to run it and what it must do; nothing
here repeats that.
