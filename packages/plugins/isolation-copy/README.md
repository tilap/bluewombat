# Isolation: copy

Directory-copy attach and directory-merge fold. Host (or a Transformer CLI)
loads this package when `workLine.isolation` is `@bluewombat/isolation-copy`.

```ts
import { strategy } from "@bluewombat/isolation-copy";
// strategy.isolation → Isolator
// strategy.fold → Integrator
```

No git bookkeeping. A Child is a plain directory snapshot of the Parent.

It is the isolation for a work line that is not a git tree (a manuscript, a
dataset). The slots that need git are listed in
[`@bluewombat/slots`](../slots/README.md) § Copy mode.
