# Manager kit

The FeatureManager plugin contract. Types only — no runtime, no dependency, no
Transformer. A package that wants mason to drive its tracker imports this and
nothing else. Contract: [SPECS.md](./SPECS.md).

## Stack

Repository stack — TypeScript, Node 24.20, Biome, `node:test`. See [docs/DEVELOPMENT.md](../../../docs/DEVELOPMENT.md).

## Setup

From the repository root:

```bash
nvm use
npm install
```

## Commands

| Task      | Command          |
| --------- | ---------------- |
| Lint      | `npm run lint`   |
| Format    | `npm run format` |
| Typecheck | `npm run tsc`    |
| Test      | `npm test`       |
| Build     | `npm run build`  |

## Write a manager

One export is required: `createManager`. Host calls it once at boot and drives
the `ManagerPort` it returns.

```ts
import {
  type CreateManagerResult,
  type ManagerContext,
  rejectUnknownOptions,
  stringOption,
} from "@bluewombat/manager-kit";

const KNOWN_OPTIONS = ["board", "tokenEnv"] as const;

export function createManager(context: ManagerContext): CreateManagerResult {
  const known = rejectUnknownOptions(context.options, KNOWN_OPTIONS);
  if (!known.ok) {
    return known;
  }
  const board = stringOption(context.options, "board");
  if (!board.ok) {
    return board;
  }
  if (board.value === undefined) {
    return { ok: false, reason: 'managerOptions "board" is required.' };
  }
  return { ok: true, manager: openMyTracker(board.value, context) };
}
```

Then point a config at it:

```json
{ "manager": "@acme/manager-jira", "managerOptions": { "board": "APP" } }
```

`checkManager` is optional. Export it and `mason doctor` prints your findings
under the shared ones. It must not use the network.

`setupManager` is optional too, and is the one hook that may call the tracker
and write to it — `mason setup` plans, `mason setup --apply` performs. Keep it
idempotent.

`questionsManager` is optional as well. Return the questions `mason init`
should ask, and Host fills `managerOptions` from the answers:

```ts
export function questionsManager(): ManagerQuestion[] {
  return [
    {
      key: "board",
      prompt: "Board key",
      required: true,
      parse: (answer) =>
        /^[A-Z]+$/.test(answer)
          ? { ok: true, value: answer }
          : { ok: false, reason: `"${answer}" is not a board key.` },
    },
  ];
}
```

Your package is offered by `mason init` when its `package.json` keywords
contain `mason-manager`.

`probe` is optional. Export it when the tracker can answer whether an intention
Host already holds is still there — a poll cannot see a deletion. `gone` is
abandon; `unavailable` is not.

`scaffoldManager` is optional. Export it and `mason init --manager this-package`
fills `managerOptions` from it. A tracker field (`repo`, a board id) belongs
there, not as a Host flag.

`referenceManager` is optional, and only for a manager whose Authority holds
the reference work line. It returns where that reference is, as a record Host
copies through unread; the Isolation strategy the Project names is what reads
it, strictly, so agree on the words with that package (`remote` and `branch`
for `@bluewombat/isolation-git`). With it, `mason init` asks nothing about the
work line and Host keeps its own copy at `<home>/work-line` (`.mason` by default).

## Layout

```
SPECS.md   the contract a manager package implements
README.md  how to build it, and how to write a manager
src/
  port.ts     ManagerPort and the values it exchanges
  module.ts   ManagerContext, ManagerModule, Finding
  options.ts  readers for one managerOptions object
```
