# Host

The process that runs the kernel, and the two contracts anything plugged into
it must answer. Three packages, one direction of dependency:

```
plugins  →  manager-kit / slot-kit  →  kernel
runtime  →  kernel
```

| Package                    | Role                                                                                              | Who depends on it                     |
| -------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------- |
| [`runtime/`](./runtime/)   | The composition root and the binary `mason`: config, plugin loading, the loop, operator commands | Nobody. It is what you run            |
| [`manager-kit/`](./manager-kit/) | `ManagerPort` and the manager module contract. Types and five option readers                      | A `manager-*` plugin                  |
| [`slot-kit/`](./slot-kit/) | What a slot written in Node needs to answer the Transformer or the runtime that spawned it        | A slot (`slots`, or one written elsewhere) |

## The rule

**`runtime` imports no plugin.** It loads a manager, an isolation strategy, a
persistence backend by the name a config gives, through its `plugins/` layer;
the names it ships with are strings in `runtime/src/config/defaults.ts`.
`scripts/check-host.mjs` enforces that, and the four-layer cut inside
`runtime` — see [`runtime/README.md`](./runtime/README.md) § Layers.

**The product's name is `PRODUCT` in `manager-kit`.** The binary, the config
file (`<name>.config.json`), the home directory (`.<name>`), the manager
keyword (`<name>-manager`), the labels a manager writes, every message: all
derive from that one constant. Renaming the product is one line there, one in
`isolation-git`'s `REF_PREFIX`, the `bin` and `keywords` of the manifests, and
the docs; `scripts/check-name.mjs` refuses the name spelled anywhere else in
source.

**A kit depends on nothing here.** A manager or a slot may live in any
repository: it imports its kit from npm and never `@bluewombat/runtime` or a
Transformer. The other way round holds too — `runtime` imports `manager-kit`, no
Transformer imports either kit.

Everything a plugin may know is in a kit. If `runtime` needs a plugin to do
something new, the kit changes first, then the plugin.

Layout of the whole tree: [`packages/README.md`](../README.md).
