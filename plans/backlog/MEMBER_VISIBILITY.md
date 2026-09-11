# Member visibility

**Status:** BACKLOG — designed here, not started. Written 2026-09-10 because
three rows of `plans/STD_API_STABILIZATION.md` cannot be closed without it,
and because the convention standing in for it has grown to 752 sites in
`std/` alone.

## The problem

Yo has no visibility mechanism. A `struct`'s fields and an `impl`'s methods
are reachable by anyone who can name the type; `export(...)` controls only
which *module-level bindings* a module publishes, and says nothing about a
type's members. The stand-in is a naming convention — a leading underscore
means "do not touch" — and nothing enforces it:

```
$ grep -rn "^  _[a-z_]* : (fn" --include="*.yo" std/ | wc -l
345          # underscore-prefixed METHODS in std
$ grep -rn "^      _[a-z_]* : " --include="*.yo" std/ | wc -l
407          # underscore-prefixed FIELDS in std
```

752 members are documented as private and enforced as public.

## What it blocks, concretely

Three `STD_API_STABILIZATION.md` rows name it directly:

| row | what leaks |
| --- | --- |
| `_raw_lock`/`_raw_unlock`/`_raw_handle_ptr` off `Mutex`'s public surface | a caller can lock a `Mutex` and never unlock it, bypassing the `__MutexUnlocker` guard that makes `with_lock` exception-safe |
| `ctrl`/`data`/`size` private on `HashMap` | the open-addressing control bytes and the raw bucket array are callable; writing one corrupts the map |
| `imm/*` internals | `imm/Vec`'s `_raw_alloc`/`_move_elems` (`std/imm/vec.yo:75,114`) hand out and move raw allocations |

And the same hazard, unrecorded, in every type that owns a resource behind a
handle: `Watcher._handle`, `File._fd`, `TcpStream._fd`, `Child._stdin_fd`,
`ChildStdin._fd`. Each is a descriptor a caller can close twice.

## Why "just make them module-private" does not work

The `_raw_*` methods are called from OTHER modules inside `std/`:

```
std/thread.yo:270     pool._mutex._raw_lock();
std/thread.yo:281     pool._mutex._raw_unlock();
std/sync/waitgroup.yo:54,65,73,77
std/sync/once.yo      (documented call sites)
std/sync/cond.yo:50   cv.wait_timeout(m._raw_handle_ptr(), deadline)
```

`WaitGroup` and `ThreadPool` genuinely need the unguarded pair: they hold the
lock across a condition-variable wait, which `with_lock`'s closure shape
cannot express. So a two-state public/private split would either break them or
leave the methods public. Any design has to answer *"private to whom?"*.

## Design options

### Option 1 — Rust's `pub` (opt-in public, module-scoped, with `pub(...)`)

Members are private by default; `pub` publishes. `pub(crate)`-style scoping
handles the `_raw_*` case: private to callers outside `std/`, visible within.

- **For:** the model every Yo contributor already knows; `pub(crate)` is
  precisely the "std-internal" notion needed here.
- **Against:** "private by default" inverts the meaning of every existing
  declaration in the tree. `std/` alone would need `pub` on thousands of
  members, `src/` more, and every user program breaks at once. Yo has no
  crate concept to hang `pub(crate)` on — the unit is a module, and `std/` is
  a directory of them.

### Option 2 — opt-in `priv`, module-private (RECOMMENDED)

Members stay public by default; a `priv` marker restricts a member to the
module that declares it.

```rust
Mutex :: (fn(comptime(T) : Type) -> comptime(Type))(
  ref(struct(priv _handle : __YO_THREAD_SYNC_TYPE, priv _value : T))
);
impl(
  Mutex(T),
  priv _raw_lock : (fn(self : Self) -> unit)(…),
  with_lock : (fn(…) -> R)(…)
);
```

- **For:** additive. Nothing existing changes meaning, so it can land in one
  release and be adopted module by module — which matters for a seed-gated
  `std/`. It matches the underscore convention already in the tree, so
  adoption is mechanical and reviewable (`priv` on the members already spelled
  `_name`).
- **Against:** the default is still wrong, in the sense that a new field is
  public until someone remembers otherwise. And it needs a second, wider scope
  for the cross-module `std/` callers (below).

### Option 3 — `sealed` types (no member visibility at all)

Instead of per-member visibility, mark a TYPE as constructible/destructurable
only by its own module, and require all access through its methods.

- **For:** far smaller change; fixes the field half of the problem outright.
- **Against:** does nothing for `_raw_lock` — the actual blocking row is about
  METHODS. Rejected as insufficient.

## Recommendation

**Option 2, plus one scope beyond module-private.** Two markers:

- `priv` — visible only inside the declaring module (file).
- `priv(<path prefix>)` — visible inside a directory subtree, spelled as a
  path relative to the std/package root: `priv("std/sync")` for the mutex
  internals that `waitgroup.yo` and `cond.yo` share, `priv("std")` for
  anything `std/thread.yo` must reach.

A path-prefix scope, rather than Rust's crate/module tree, is the right shape
for Yo because Yo's unit of code IS a path (`import("std/sync/mutex")`), and
`std` is a directory rather than a compilation unit. `priv("std/sync")` reads
as what it means and needs no new namespace concept.

## Implementation sketch

1. **Lexer/parser** — `priv` and `priv(<string>)` as a member prefix in
   `struct(...)`, `enum(...)` payloads and `impl(...)` field lists. Parsed
   into a `Visibility` field on the member's AST node (`src/expr.yo`).
   `priv` must NOT become a reserved word usable nowhere else; follow
   `pragma`'s treatment.
2. **Types** — carry `Visibility` on struct fields and on impl entries
   (`src/types/`), and on the registry entries the evaluator looks members up
   through (`g_impl_registry_*` in `src/evaluator/values/impl.yo`).
3. **Evaluator** — one check at each member-resolution site, comparing the
   accessing expression's module path against the member's scope. The sites
   are property access (`src/evaluator/exprs/property_access.yo`), method call
   resolution (`src/evaluator/calls/`), and struct-literal construction. The
   error is a new `E0xxx` naming the member, its scope, and the accessing
   module.
4. **Codegen** — nothing. Visibility is a compile-time check; emitted C is
   unchanged, which means the fixpoint gate should show byte identity for a
   tree that has not yet ADOPTED any marker. That is the acceptance test for
   the mechanism landing (see
   `yo-byte-identity-gate-for-additive-codegen-change`).
5. **`derive`** — a derived body reads every field. Derives must be exempt
   (they are generated inside the declaring module's evaluation), and the
   exemption needs a test: `derive(Eq)` over a type with `priv` fields, used
   from another module.

## Adoption plan (after the mechanism lands)

One PR per module group, in this order, because each is a real hazard:

1. `std/sync/*` — `_raw_lock`/`_raw_unlock`/`_raw_handle_ptr` become
   `priv("std/sync")`, `_handle`/`_value` become `priv`. Closes the row.
2. Resource handles — `File._fd`, `TcpStream._fd`, `UdpSocket._fd`,
   `Watcher._handle`, `Child._*_fd`, `ChildStdin._fd`. Each prevents a
   double close.
3. `std/collections/*` — `ctrl`/`data`/`size` and friends. Closes the row.
4. `std/imm/*` — `_raw_alloc`/`_move_elems`. Closes the row.

Each step is seed-gated: `std/` cannot use `priv` until a release ships a
compiler that parses it ([[yo-seed-gate-blocks-std-using-new-runtime-macros]]
is the same sequencing).

## Open questions for the maintainer

- Is `priv`/`priv("path")` the spelling, or `private`? (`priv` matches the
  existing `_` convention's brevity; `private` reads better in a doc comment.)
- Should `priv` on a struct field also make the type non-constructible by
  literal from outside, or only non-readable? Rust's answer is
  non-constructible; that is stricter and would force constructor functions
  (`Mutex.new`) everywhere, which `std/` already has.
- Do `tests/` get an exemption? `tests/sync/timedwait.test.yo` calls
  `_raw_unlock` directly today. Either the tests move to the public surface,
  or `priv` needs a test-only escape — the first is better, and the test in
  question exists to exercise the runtime macros, which `try_with_lock` now
  covers.
