# Packages

Three groups, three rules, three scripts. The tree shows the dependency
direction; the scripts refuse a change that goes against it.

```
packages/
  kernel/    what stands alone: Conductor, WorkLedger, the four Transformers
  host/      what runs it (runtime) and the contracts it publishes (manager-kit, slot-kit)
  plugins/   what a config names and Host loads: managers, isolation, persistence, slots
```

```
plugins  →  host (the kits only)  →  kernel
host/runtime  →  kernel
kernel  →  nothing outside itself
```

| Group                       | Rule                                                                    | Checked by                  |
| --------------------------- | ----------------------------------------------------------------------- | --------------------------- |
| [`kernel/`](./kernel/)      | A package imports nothing outside itself (Conductor may import WorkLedger) | `scripts/check-kernel.mjs`  |
| [`host/`](./host/)          | `runtime` imports no plugin; inside it, four layers in one direction     | `scripts/check-host.mjs`    |
| [`plugins/`](./plugins/)    | A plugin imports its kit and kernel Ports, never `runtime` or a sibling | `scripts/check-plugins.mjs` |
| the product's name          | Written once, as `PRODUCT` in `host/manager-kit/src/product.ts`; every message, filename and label reads it. `isolation-git` repeats it in `REF_PREFIX` because it imports no kit | `scripts/check-name.mjs` |

All four run in `npm run lint`. Each group's README says what belongs in it
and what does not. Shared stack: [docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md);
where a new piece goes: [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).
