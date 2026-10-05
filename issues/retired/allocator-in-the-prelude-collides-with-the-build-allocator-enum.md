# A prelude `Allocator` collides with `std/build.yo`'s `Allocator` enum and every `{ Allocator }` import

**Resolved 2026-10-04:** option 1 taken (maintainer, via the coordinator). The build enum is now `build.AllocatorKind`. Moving `Allocator`/`AllocatorVTable`/`impl(Allocator, Send())` into the prelude (with the inherent impl staying in `std/allocator.yo`) turned out to be seed-gated by the borrow-mask analysis's declaring-module test; it is parked as Generation B in `plans/backlog/SEED_VERSION_AUTOMATION.md`.

**Kind:** design question — an open decision, not a defect. Raised 2026-10-04
while implementing `plans/VALUES_BY_DEFAULT.md` V1, std Generation A, first
bullet ("Move `Allocator` and `AllocatorVTable` into the prelude (§3.11);
`std/allocator.yo` re-exports them").

## What the plan assumed

§3.11 moves the two structs into `std/prelude.yo` so the V1 constructors
(`box`/`rc`/`arc` with `alloc : Option(Allocator)`) can name the type, and
says `std/allocator.yo` re-exports them so existing imports keep working.

## What the compiler does

Yo forbids shadowing, and a prelude name counts. Measured 2026-10-04 with the
installed seed v0.2.50 and the tree's std (`yo check <file> --std-path ./std`),
with the two structs added to the prelude:

1. **`std/build.yo` defines its own `Allocator`**, the build option enum
   (`Mimalloc`/`System`/`Fixed`, the type of `executable({ allocator : ... })`):

   ```
   error: Failed to define variable "Allocator":
       --> std/build.yo:53:1
   note: Variable "Allocator" is already defined here (variable shadowing is not allowed):
       --> std/prelude.yo:277:1
   ```

   So the move breaks every build file, the repository's own `build.yo`
   included.
2. **A re-export does not keep imports working.** A module may `export(...)` a
   prelude name, but an importer's destructure `{ Allocator } :: import("std/allocator")`
   binds `Allocator` again in the importer, and that is the same shadowing
   error, even though the value is identical (reproduced with the prelude's
   `GcTracer`: `{ GcTracer } :: import("./reexp.yo")` fails the same way).
   The destructures that would break: `std/arena.yo` (also `AllocatorVTable`),
   `std/imm/{vec,string,map}.yo`, `std/collections/{array_list,deque,hash_map,hash_set}.yo`,
   `std/string/string_builder.yo`, `tests/arena.test.yo` (also `AllocatorVTable`),
   `tests/explicit_allocators.test.yo`, and the
   `a-default-parameter-resolves-names-in-the-defining-module` cli-case
   fixture. Dropping the name from those destructures is mechanical and
   seed-safe (the seed reads the prelude like any other std module).

Point 2 is mechanical. Point 1 is a public API decision: renaming the build
enum changes every user's `build.yo`, `docs/{en-US,zh-CN}/BUILD_SYSTEM.md` and
`WASM.md`, two skill cheatsheets (`yo-project-workflow`,
`yo-wasm-integration`, which re-records the seven skill-tree cli goldens), and
four cli-case `build.yo` fixtures (`compile-allocator-fixed*`,
`raw-extern-future-sync-await-releases`).

The seed does not block a rename: every CI `yo build` passes
`--std-path ./std` (`test.yml`, `fixpoint-arm64.yml`, `ubsan.yml`; the release
smoke sets `YO_STD` to the bundle's own std), so renaming the enum in
`std/build.yo` and in the root `build.yo` in one commit is plain std code to
the seed. A developer who runs a bare `yo build` would load the seed's bundled
std and fail until the next seed. AGENTS.md already requires `--std-path`.

## Options

1. **Rename the build enum.** For example `build.AllocatorKind` or
   `build.HeapAllocator`. Then move the structs and drop them from the
   destructures listed above, in one PR. This follows the plan's naming:
   `Allocator` is the runtime allocator value everywhere, and the build option
   gets a name that says it picks one.
2. **Give the prelude type a reserved name** (`__Allocator`), have
   `std/allocator.yo` bind `Allocator :: __Allocator`, and spell the V1
   constructor signatures `Option(__Allocator)`. No user-visible rename, but
   hover, `yo doc` and diagnostics show the reserved name in every
   constructor signature, which is the surface the move was meant to clean
   up.
3. **Allow an import destructure to rebind a prelude name to the identical
   value.** This needs new compiler behaviour, so std cannot rely on it until
   the seed carries it, and it does not solve point 1.
4. **Leave `Allocator` in `std/allocator.yo`** and have the prelude
   constructors import it. This is not possible: `std/allocator.yo` depends on
   the prelude (§3.11).

## Recommendation

Option 1, as its own PR before the V1 constructors land. Rename the build enum
to `build.AllocatorKind`, with the variants unchanged. There are no aliases,
per AGENTS.md's no-backward-compatibility rule. In the same PR, move the two
structs and `impl(Allocator, Send())` into the prelude. Keep `Allocator`'s
inherent impl (`global`, `alloc`, `realloc`, `free`, `owner_of`, `same`) in
`std/allocator.yo`, which also keeps the global vtable, the owner prefix
helpers, `with_allocator` and `current_allocator`; there is no orphan rule, so
an inherent impl may live there. That leaves two open points:

- Until a module that loads `std/allocator.yo` is in the program, a value of
  the prelude type has no methods. Every way to obtain an `Allocator` today
  (`Allocator.global()`, `Arena.allocator()`, `current_allocator()`) already
  imports that module, so this is not observable. It becomes observable only
  if a later prelude API hands out an `Allocator` on its own.
- Re-record the skill-tree goldens, which the skill cheatsheet edits move.
