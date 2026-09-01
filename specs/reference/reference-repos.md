# Reference Repositories

This project vendors reference source as git subtrees in `repos/` for pattern
discovery and API lookup. The trees are read-only: never edit them, never
import from them (see the root `AGENTS.md`).

## Effect (`repos/effect/`)

The Effect **v4** monorepo, pinned to the `effect@4.0.0-rc.112` tag — the same
version as `package.json`. Unlike v3, most of the ecosystem lives inside the
single `effect` package (platform, atom, and sql drivers are the main
exceptions).

### Start here

| File | Purpose |
|------|---------|
| `repos/effect/LLMS.md` | Agent-facing guide to v4 idioms; read this first |
| `repos/effect/ai-docs/src/` | Runnable examples, organized by topic |
| `repos/effect/packages/effect/SCHEMA.md` | Comprehensive Schema guide (large; read in chunks) |
| `repos/effect/MIGRATION.md` | v3 → v4 migration notes |

### Core Package (`repos/effect/packages/effect/src/`)

This project imports these as subpaths, e.g. `import * as Effect from 'effect/Effect'`:

| Module | Path | Use For |
|--------|------|---------|
| **Effect** | `Effect.ts` | Core effect type, `Effect.gen`, `Effect.fn` |
| **Schema** | `Schema.ts` | Validation, encoding/decoding, `Schema.TaggedError` |
| **Context** | `Context.ts` | Dependency injection, `Context.Service` |
| **Layer** | `Layer.ts` | Service composition, `Layer.effect`, `Layer.launch` |
| **Data** | `Data.ts` | Value objects, `Data.TaggedError` |
| **Cause / Exit** | `Cause.ts`, `Exit.ts` | Failure inspection, run results |
| **Fiber** | `Fiber.ts` | Concurrent execution, interruption |
| **Deferred** | `Deferred.ts` | One-shot handoff between fibers |
| **Scope** | `Scope.ts` | Resource lifetimes, finalizers |
| **Schedule** | `Schedule.ts` | Retry/repeat policies |
| **Ref / SynchronizedRef** | `Ref.ts`, `SynchronizedRef.ts` | Mutable state |
| **Queue** | `Queue.ts` | Async queues |
| **Stream** | `Stream.ts` | Pull-based effectful sequences |
| **Metric** | `Metric.ts` | Counters, histograms |
| **Config** | `Config.ts` | Configuration |
| **Option / Result** | `Option.ts`, `Result.ts` | Optional values, sync error handling (v4 renames `Either`) |
| **Match** | `Match.ts` | Pattern matching |
| **Duration / DateTime** | `Duration.ts`, `DateTime.ts` | Time |
| **Predicate** | `Predicate.ts` | Runtime type guards (never hand-roll `isString` etc.) |

### Unstable modules (`repos/effect/packages/effect/src/unstable/`)

In v4 the former `@effect/*` satellite packages mostly live here, imported as
`effect/unstable/<area>/<Module>`:

| Area | Path | Used here for |
|------|------|---------------|
| **socket** | `unstable/socket/` | `Socket`, `SocketServer` — the daemon's unix-socket wire |
| **process** | `unstable/process/` | `ChildProcess`, `ChildProcessSpawner` — spawning cargo |
| **reactivity** | `unstable/reactivity/` | `Atom`, `AtomRegistry` — state behind `@effect/atom-react` |
| **http / httpapi** | `unstable/http/`, `unstable/httpapi/` | HTTP clients and schema-first servers |
| **rpc** | `unstable/rpc/` | RPC framework |
| **cli** | `unstable/cli/` | CLI argument parsing |
| **observability** | `unstable/observability/` | Otlp exporters |

### Platform (`repos/effect/packages/platform/`)

`@effect/platform-node` sources are at `repos/effect/packages/platform/node/src/`
(`NodeSocket.ts`, `NodeServices.ts`, `NodeFileSystem.ts`, `NodeRuntime.ts`, …).
Browser/Bun/Deno variants sit alongside in `browser/`, `bun/`, `deno/`.

### Atom (`repos/effect/packages/atom/`)

`@effect/atom-react` sources are at `repos/effect/packages/atom/react/src/`
(`Hooks.ts`, `RegistryContext.ts`, `ScopedAtom.ts`). The core `Atom` module is
in `unstable/reactivity` (above), not in this package.

### Tests (`repos/effect/packages/effect/test/`)

Real usage examples for nearly every module; `@effect/vitest` helpers are in
`repos/effect/packages/vitest/src/`.

## Common search patterns

v4 idioms differ from v3 — search for these, not their v3 counterparts:

```bash
# Service definitions (v4: Context.Service, not Context.Tag)
rg "extends Context.Service" repos/effect/packages/effect/src/ repos/effect/ai-docs/

# Tagged errors (v4: Schema.TaggedError preferred)
rg "Schema.TaggedError" repos/effect/ai-docs/src/

# Effect.fn (v4 replacement for functions returning Effect.gen)
rg "Effect.fn\(" repos/effect/ai-docs/src/ | head -20

# Layer composition
rg "Layer.provide|Layer.provideMerge" repos/effect/ai-docs/src/

# Schema class/struct definitions
rg "Schema.Class|Schema.Struct" repos/effect/ai-docs/src/

# Real-world module usage in tests
rg "Deferred.make" repos/effect/packages/effect/test/ | head -10
```

## Package versions

```bash
jq .version repos/effect/packages/effect/package.json          # effect
jq .version repos/effect/packages/atom/react/package.json      # @effect/atom-react
jq .version repos/effect/packages/platform/node/package.json   # @effect/platform-node
```

## Updating the subtree

Only when deliberately moving to a new Effect version, alongside the matching
`package.json` bump:

```bash
git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git effect@<version> --squash
```
