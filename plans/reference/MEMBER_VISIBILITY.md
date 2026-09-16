# Member visibility

**Status:** LANDED 2026-09-16 (PR #716) — as the compiler-ENFORCED underscore
convention, NOT the `priv` marker recommended below. The maintainer's
decision: "any field starting with `_` is the private field". No new syntax,
so `std/` adopts it without waiting for a seed release. What shipped:

- **Rule.** A struct field or impl method whose name starts with `_` is
  private to the module that declares its type or impl **and to that
  module's same-directory siblings** (the scope every `_raw_lock` caller in
  `std/sync/` needs; `std/thread.yo` is outside it). Names starting with
  `___` are compiler-reserved (the synthesized RC hooks) and never private.
  Trait-declared signatures and module exports are untouched — `export(...)`
  is still the only control over module-level bindings.
- **Enforced at** property access (read and write), method resolution
  (instance and `Type._m(...)` static forms, inherent and generic-impl
  methods — generic-impl candidates carry their impl's declaring module),
  struct-literal construction (a type with any private field is not
  constructible by literal from outside) and destructuring (named fields and
  the `{ ... }` spread). Answers to the open questions at the bottom:
  non-constructible/non-destructurable YES, `tests/` exemption NO.
- **Diagnostic** `E0405` (`yo explain E0405`); classifier keys on
  "is private". Codegen is untouched — the emitted C is byte-identical.
- **Mechanism.** `register_type_decl_module` / `type_decl_module`
  (`src/types/guards.yo`) record a type id's declaring module at struct /
  enum / union / anonymous-struct minting; `MethodEntry.owner` and
  `MethodCandidate.owner` carry the registration owner; the shared predicate
  is `private_member_blocked` in `src/utils.yo`. Tests:
  `tests/member_visibility.test.yo` (+ `tests/member_visibility/`),
  `tests/cli-cases/check-private-member`.
- **std API the rule forced into the open** (each replaced a cross-directory
  reach into a `_` member): `Cond.wait_with(m)` / `wait_timeout_with(m, d)`
  (Mutex-typed, for use inside `with_lock`), `RawMutex` (an unguarded
  lock/try_lock/unlock for the thread pool's split lock — `with_lock`'s
  closure cannot hold a lock across two functions), `Command.get_args` /
  `get_program`, `File.into_fd` (Rust's `IntoRawFd`), `HashSet.k0/k1/
  tombstones` (twins of `HashMap`'s public fields), and `Statx.buf_ptr` /
  `buf_size` made public (sys plumbing constructed from `std/fs`).
- **Enumeration method.** Import chains collapse `check` to one error per
  chain, so the tree was enumerated once with a report-instead-of-throw
  build (never committed), then fixed; the full suite still found three
  more sites in bodies `check` never specializes — the suite is the gate.

Everything below is the design record as written on 2026-09-10 — three rows
of `plans/STD_API_STABILIZATION.md` could not be closed without it, and the
convention standing in for it had grown to 752 sites in `std/` alone.

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
