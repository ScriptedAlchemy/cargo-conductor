---
name: effect-ts
description: Use this skill when writing Effect TypeScript code in this repository, which uses the Effect Typescript library.
---

# Learning more about Effect

This repository uses the Effect Typescript library. `effect@4.0.0-rc.112` is
already installed as a dependency — do not reinstall or bump it — so the
package source is available at `node_modules/effect/src`.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

When the published package is not enough — you need runnable examples, the
`LLMS.md` agent guide, migration docs, or other packages from the Effect
monorepo — use the vendored subtree at `repos/effect`, pinned to the same
`effect@4.0.0-rc.112` tag. It is read-only reference material: never edit it
and never import from it in application code.
