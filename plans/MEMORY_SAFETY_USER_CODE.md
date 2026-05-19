# Memory Safety: Safe User Code, Unsafe Stdlib

## Goal

Make Yo memory-safe **for user code, by construction** — not by lifetime checking, not by region inference, but by **removing the dangerous primitives from the user-facing language entirely.** Raw pointers, `unsafe(...)`, `asm(...)`, and direct FFI become stdlib-only privileges. User code can only use safe constructs (`object`, `Iso(T)`, `Arc(T)`, value types, bounds-checked collections, the new `inout` parameter form).

This is Swift's model. It's Go's model. It's Java's model. All three are widely accepted as memory-safe. The unsafe surface is bounded to a small, audited stdlib that improves over release-on-release.

The pitch becomes: **"User code cannot violate memory safety. The unsafe surface is confined to the standard library, which is small, audited per release, and fuzz-tested. FFI is wrapped in safe APIs."**

## Prerequisite

Builds on [`MEMORY_SAFETY.md`](MEMORY_SAFETY.md). The `unsafe(...)` marker is required to mark stdlib-internal unsafe sites; this plan adds the user-vs-stdlib privilege gate on top.

## Non-Goals

- **No `&(T)` reference type, no Origins, no lifetimes.** See [`FUTURE_ORIGINS.md`](FUTURE_ORIGINS.md) for the deferred design.
- **No restrictions on what user code can _call_** — every stdlib function remains callable. Restrictions apply to what user code can _write_: which types it can declare, which operators it can use, which constructs appear in its source.
- **No formal soundness proof.** Safety is achieved by removing the constructs that cause UB from the user's vocabulary; the claim is "user code cannot express UB," not "the type system proves UB-freedom."

---

## Design

### The Privilege Gate

Every Yo source file is either **safe** (default) or **unsafe-capable** (opt-in via pragma). There is **no path-based privilege** — files under `std/` and `yo-self/` must declare the pragma explicitly, same as any other file. One uniform rule:

```rust
pragma(Pragma.AllowUnsafe);
```

`pragma(...)` is a new builtin (added to `BuiltinKeywords`) that takes one `comptime(Pragma)` argument. `Pragma` is an enum defined in `std/prelude.yo`:

```rust
Pragma :: enum(
  AllowUnsafe   // opt into raw pointers, unsafe(...), asm(...), extern fn
  // future variants: NoMain, Deprecated, Strict, ...
);
```

The argument must be comptime-known so the file's privilege level is determined at parse time. Multiple `pragma(...)` declarations may appear at the top of a file; each contributes a single flag.

**Rationale for no path-based exceptions:**

- **One rule to learn.** No "this directory is special." Safe by default, opt in via pragma, full stop.
- **Easier `yo check --unsafe-report`.** Greppable surface — every privileged file declares itself.
- **Safe relocation.** Moving a file in/out of `std/` doesn't silently change its safety status.
- **Simpler compiler logic.** Parser checks for the pragma; no path lookup against a privilege table.

The cost is mechanical: every `std/*.yo` and `yo-self/*.yo` file gets `pragma(Pragma.AllowUnsafe);` added at the top during the rollout (Phase C below). ~100 files; one-pass migration.

**Project policy** via build system stays optional: `build.yo` can declare a project-wide override for systems-programming projects, but the per-file pragma is the canonical mechanism.

**Default for user code: safe.** A user writes `yo init` → `main.yo` → starts coding; they cannot reach for `*(T)` without explicitly adding the pragma. LLM-generated code defaults to safe.

### What Safe Code Cannot Do

The rule is structural: **no expression in safe code may have type `*(T)`**, and no declaration in safe code may name `*(T)` in a parameter, field, or return type. This is checked per expression, not per byte-pattern — values whose _internal representation_ contains pointers (e.g. `Slice(T)`, `ArrayList(T)`, `String`) are fine, because the user-visible type isn't `*(T)`.

In a file without the unsafe privilege, the following are compile errors:

| Construct                                                                        | Diagnostic                                                                                                       |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Declaring a parameter, field, or return of type `*(T)`                           | `error: raw pointer types are not available in safe code. Use 'object', 'Slice(T)', or 'inout(...)' parameters.` |
| Writing an expression with type `*(T)` (e.g. `&(expr)`, `slice._ptr`, `*(T)(x)`) | `error: this expression has type '*(T)', which is not available in safe code.`                                   |
| Calling a function whose return type is `*(T)`                                   | rejected at the call site (the result expression would have type `*(T)`)                                         |
| `unsafe(...)` block                                                              | `error: 'unsafe(...)' is not available in safe code. This operation requires 'pragma(Pragma.AllowUnsafe);'.`     |
| `asm(...)` block                                                                 | `error: inline assembly is not available in safe code.`                                                          |
| `extern fn` declaration                                                          | `error: extern FFI declarations are not available in safe code. Call stdlib wrappers (e.g. 'std/sys').`          |
| Pointer arithmetic operators (`&+`, `&-`, `&/`, etc.)                            | `error: pointer arithmetic requires raw pointers, which are not available in safe code.`                         |
| `consume(p.* = v)` on a pointer deref                                            | `error: 'consume' on a pointer deref requires raw pointers, which are not available in safe code.`               |

Each error includes a "what to use instead" hint pointing at the safe alternative.

### What Safe Code _Can_ Do With Pointer-Backed Types

`Slice(T)`, `ArrayList(T)`, `HashMap(K, V)`, `String`, etc. all contain raw pointers in their internal representation. They are safe to expose to user code because:

1. **No public API method has `*(T)` in its signature.** Every method takes/returns safe types (`usize`, `Option(T)`, `Self`, etc.). Lint enforces this in stdlib.
2. **Field accesses that would yield `*(T)` are rejected in safe code** by the rule above. `slice._ptr` typechecks in stdlib but errors in user code: "this expression has type '\*(T)'."
3. **Construction with arbitrary pointer contents is impossible.** User code can't construct a `*(T)` to put in a field, so it can't bypass the safe constructors.
4. **All indexing is bounds-checked.** `slice(i)`, `arr.get(i)`, `list(usize(0))` either trap or return `Option(T)` on OOB. Pointer arithmetic happens inside stdlib `unsafe(...)` blocks with a verified bounds invariant.

This is the standard abstraction-as-safety pattern — same as Rust's `Vec<T>`, Swift's `Array<T>`, Go's slices. The implementation has the privilege; the interface stays safe.

### What Safe Code Can Do (Everything Else)

- Value types: `i32`, `bool`, `str`, structs, enums, tuples, `Array(T, N)`, `Slice(T)`
- RC-managed types: `object`, `Iso(T)`, `Arc(T)`
- Heap collections: `ArrayList(T)`, `HashMap(K, V)`, `HashSet(T)`, `Deque(T)`, etc.
- Options/Results: `Option(T)`, `Result(T, E)`
- Closures and higher-order functions over safe types
- Algebraic effects, async/await, comptime
- Generics, traits, GADTs, all of Yo's type system features
- The new `inout` parameter form (next section)

### `inout` Parameters

To recover the in-place-mutation pattern (`swap`, `increment`, etc.) without introducing references as a first-class concept, safe code gets a `inout` parameter form, modeled on Pascal / Nim / C#'s `ref` / `out`:

```rust
swap :: (fn(inout(a) : i32, inout(b) : i32) -> unit)({
  tmp := a;
  a = b;
  b = tmp;
});

main :: (fn() -> unit)({
  x := i32(1);
  y := i32(2);
  swap(x, y);              // no &() needed — inout-ness is in the param spec
  assert((x == i32(2)), "swapped");
});
```

Semantics:

- A `inout` parameter is **pass-by-reference** at the calling convention level (compiles to a `T*`).
- Inside the callee, the identifier `a` behaves like a binding to the caller's variable: reading gives the current value, writing updates it.
- **Non-escape is enforced syntactically.** A inout-param identifier may appear:
  - On the right-hand side of an expression (deref)
  - On the left-hand side of an assignment
  - As an argument to another function's `inout` parameter
  - Nowhere else.
- The following are compile errors:
  - Returning a inout-param as a binding (returning its value is fine; "returning the binding" is impossible because `inout(...)` is not a type)
  - Storing a inout-param in a `let`-binding (`r := a` copies the value, which is fine; you cannot bind to the reference itself)
  - Capturing a inout-param in a closure (most closure forms — see Open Question 6)
  - Putting a inout-param into a struct field (no syntax for this; `inout(...)` is a parameter-only modifier)

This is essentially "second-class references restricted to parameter syntax." Because there's no `inout` _type_, only an `inout` _parameter modifier_, the non-escape rule is trivially enforced — there's no way to write down a value of "inout type" that could escape.

### `inout(...)` Parameter Syntax

Yo's parameter modifiers follow a uniform shape: the modifier wraps the parameter name as a function-call-style annotation, then the type annotation follows. This matches the existing `own(name) : Type` pattern (used pervasively in `std/prelude.yo` and `std/imm/`):

```rust
fn(inout(name) : Type, ...) -> Return
fn(own(name) : Type, ...) -> Return         // existing — consumes the argument
```

Type annotation is required (same as regular parameters). Multiple `inout(...)` params are allowed in any position. `inout(...)` and `own(...)` are mutually exclusive on the same parameter.

### Iteration in Safe Code

Yo's current iterator API returns `*(T)` from `next()`:

```rust
ArrayIterPtr :: ...
impl(... Iterator(Item : *(T), next : ... -> Option(*(T))));

for(arr.iter(), (ptr) => { print(ptr.*); });   // ptr : *(T) — REJECTED in safe code
```

Under this plan, `ptr : *(T)` is a forbidden type in safe code, so the pointer-iterator API breaks at the user boundary. Three iteration patterns replace it:

#### 1. Value iteration (default `iter()` and `into_iter()`)

Public iterators yield `T` by value. The `for` macro works unchanged — the bound variable has type `T`, not `*(T)`:

```rust
for(arr.iter(), (x) => {        // x : T
  print(x);
});
```

For `T = i32`/`bool`/small structs: zero overhead (fits in registers). For `T = object`: one RC dup per yield (cheap, often elided by ownership analysis). For `T = large value-struct`: one memcpy per yield (real overhead — see Performance below).

The current `*IterPtr` types either get renamed `*IterRaw` (stdlib-only) or are removed entirely; only value iterators are exposed publicly.

#### 2. Index-based iteration for in-place mutation

For collections supporting `Index` + indexing-assignment (`Array`, `Slice`, `ArrayList`), use Yo's existing `arr(i) = value` syntax:

```rust
for(arr.indices(), (i) => {
  arr(i) = (arr(i) * i32(2));
});
```

`indices()` returns an iterator yielding `usize` from 0 to length. Bounds checks on each `arr(i)` access; the optimizer typically hoists them out of the loop when the bound is provable.

Does not work for unordered collections (`HashMap`, `HashSet`) where indexing isn't well-defined.

#### 3. Callback-based mutation with `inout` params

For general mutable iteration (including `HashMap`, etc.), a new trait `IteratorMut` provides a callback-style API:

```rust
arr.each_mut((x) => {
  x = (x + i32(1));
});

hashmap.values_mut((v) => {
  v.tweak();
});
```

The inout-ness is part of the `Fn(...)` signature that `each_mut` expects, not something the caller writes — `=>` parameters can't carry annotations. Inside the closure body, `x` behaves as a inout-binding (assignment writes through to the element's storage). With inlining, this matches the performance of a pointer-iterator loop.

`IteratorMut` trait sketch:

```rust
IteratorMut :: trait(
  Item : Type,
  each_mut : (fn(self : Self, f : Impl(Fn(inout(x) : Self.Item) -> unit)) -> unit)
);
```

#### Migration plan for stdlib iterators

- **`iter()` on every collection** — return a value iterator yielding `T`. Replaces the current `*(T)`-yielding form.
- **`into_iter()`** — already value-yielding; unchanged.
- **`indices()`** — add on indexable collections (`Array`, `Slice`, `ArrayList`, `String` for byte indices).
- **`each_mut(...)`** — add on every collection that supports mutation. Internally uses `*(T)` + `unsafe(...)`; externally takes a `inout`-parameterized closure.
- **The old `*IterPtr` types** — move into `pragma(Pragma.AllowUnsafe);`-only modules or remove entirely. Most stdlib code that currently uses them should be rewritten in terms of `each_mut` or index iteration.

#### `for` macro

Stays unchanged. Already works with value iterators since the binding type is `Self.Item`, which becomes `T` instead of `*(T)`. No new syntax for `for` is required.

#### Performance considerations

The cost of removing pointer iterators from public APIs:

| Iteration shape                  | Pointer iterator (current) | Value iterator (safe)       | Overhead         |
| -------------------------------- | -------------------------- | --------------------------- | ---------------- |
| `Array(i32, N)`                  | load pointer + deref       | load value into register    | ~0%              |
| `ArrayList(object MyType)`       | load pointer               | load pointer + RC dup       | RC dup per yield |
| `Array(BigStruct, N)` (64 bytes) | load pointer               | memcpy 64 bytes             | ~8× per yield    |
| `HashMap.values()`               | load pointer               | load value + RC dup or copy | RC dup or memcpy |

Mitigations:

- **Yo's ownership analysis** already elides many RC dup/drop pairs (see `COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md`). For typical iteration patterns the per-yield RC traffic is often zero.
- **`each_mut` with inlined closure** matches pointer-iterator performance for in-place mutation. The closure body inlines, the `inout` param lowers to a `T*` in C, the loop is identical to a hand-written pointer walk.
- **Index-based iteration with bounds-check hoisting** matches pointer arithmetic when the loop bound is provable; LLVM handles this routinely.
- **Performance-critical paths that genuinely need raw-pointer iteration** can opt into `pragma(Pragma.AllowUnsafe);` or push the hot path into a stdlib module.

The honest expected impact for safe user code:

- **Typical application code**: 1–5% overhead vs raw-pointer iteration. Dominated by other costs; iteration isn't the bottleneck.
- **Tight numerical loops (Array of small types)**: 0–10% overhead. Optimizer handles most of it.
- **Iteration over large value structs**: 2–5×. Rare in practice; mitigated by switching to `object` wrappers (one RC dup vs full memcpy) or opting into unsafe.
- **RC-heavy code with `object` types**: 0–3%. Ownership analysis is the savior.

### Stdlib Boundary

The stdlib continues to use `*(T)`, `unsafe(...)`, and `asm(...)` internally. Public stdlib APIs expose safe types only:

- **Allowed in public stdlib signatures:** all the safe types listed above, plus `inout(name) : T` parameters where in-place mutation is the right ergonomics.
- **Forbidden in public stdlib signatures:** `*(T)`. Stdlib internals can use raw pointers; the public surface cannot expose them.

The `pkg-config`-style boundary is enforced by a lint, not by the type system. A stdlib API that returns `*(T)` is technically legal but flagged in CI.

### FFI

User code cannot declare `extern fn`. To call a C function, user code calls a stdlib wrapper:

```rust
// In std/sys/process.yo (unsafe-capable):
extern_exit :: extern_fn("exit", fn(code : i32) -> never);

exit :: (fn(code : i32) -> never)(
  unsafe(extern_exit(code))
);

// In user code:
{ exit } :: import("std/sys/process");

main :: (fn() -> unit)({
  cond(
    bad_state => exit(i32(1)),
    true => ()
  )
});
```

User code that needs to bind a new C library writes a stdlib-flavored wrapper module with `pragma(Pragma.AllowUnsafe);` at the top, audits it, and treats it as part of their project's trusted base. This is the same workflow as writing FFI bindings in Swift or Go.

### Closures and Captures

Under this design, closures in user code can only capture safe types. Since `*(T)` doesn't exist in user code, the UAF-via-closure-capture pattern from the earlier discussion is **structurally impossible.** A closure capturing an `object` handle is fine (RC handles lifetime); a closure capturing a value type is fine (copied at capture); there is no third option.

This solves the closure-leakage concern raised in the `unsafe(...)`-only design without needing Origins.

### Allocators

User code that wants custom allocation behavior interacts with the stdlib's `Allocator` interface, not with raw memory. The `Allocator` trait is a safe API — implementing it requires `pragma(Pragma.AllowUnsafe);` because the implementation needs raw memory operations, but using one does not.

---

## Why This Is Memory-Safe

The argument is structural, not proof-theoretic:

1. UB in Yo can only arise from operations on `*(T)`: deref of an invalid pointer, arithmetic past valid memory, double-free, use-after-free. Every UB-capable operation requires `*(T)` somewhere.
2. User code cannot construct `*(T)`. The type, the `&(expr)` operator, the casts, and `unsafe(...)` are all unavailable.
3. User code can only call functions whose signatures it can write down. Those signatures use safe types only.
4. Therefore, user code cannot trigger UB.
5. The stdlib _can_ trigger UB if its `unsafe(...)` blocks are wrong. The safety claim shifts from "user code is safe" to "user code is safe iff stdlib is correct." Stdlib correctness is established by audit, testing, and per-release review — same as Swift's `Foundation`, Go's runtime, Java's `Unsafe`-using class library.

**What this does not prove:** stdlib correctness. The audit story is what closes that gap. See "Audit Discipline" below.

---

## Audit Discipline (Stdlib)

The stdlib is the trusted base. Conventions:

1. **`// SAFETY: ...` comments required.** Every `unsafe(...)` site in stdlib must be preceded by a comment explaining why the operation is safe (what invariant guarantees the deref/arithmetic is in bounds and the pointer is live).
2. **Per-release audit.** Each release of the stdlib gets a full sweep — diff the `unsafe(...)` sites since the last release, audit each one. The `yo check --unsafe-report` tool quantifies the surface.
3. **Fuzz tests.** Every collection has property-based / fuzz coverage of its unsafe internals. CI runs them.
4. **Minimize surface.** Conventions push the `unsafe(...)` block as small as possible — wrap the minimal expression, not the whole function. Reviewers grep for unsafe and see exactly what's claimed safe.

---

## Implementation Phases

The rollout is incremental. Phase A is the committed [`MEMORY_SAFETY.md`](MEMORY_SAFETY.md) (`unsafe(...)` marker) and is the foundation everything else stands on. Phase B (`inout`) can land before or after Phase C (privilege gate); they're independent.

### Phase A — `unsafe(...)` marker (already committed)

See [`MEMORY_SAFETY.md`](MEMORY_SAFETY.md). This is the foundation: pointer deref, arithmetic, and `consume(p.* = v)` require `unsafe(...)` wraps. Lands first. Stdlib gets the wraps; user code is unaffected because the privilege gate isn't in yet.

### Phase B — `inout(...)` parameters

- [ ] Parse `inout(name) : T` in function parameter lists. The `inout(...)` form is a parameter modifier wrapping the name (parallel to existing `own(name) : T`), not a type.
- [ ] In the evaluator, treat inout-params as bindings to the caller's storage. Type-check reads/writes against the underlying `T`.
- [ ] Implement the non-escape check:
  - Inout-param identifier may appear in expression-rvalue, assignment-lvalue, or as another inout-param argument. Nowhere else.
  - Reject `r := inout_param` where the binding would be a bind-to-reference (the value form copies and is fine).
  - Reject closure captures of inout-params unless the closure type is known not to escape (see Open Question 6).
- [ ] Codegen: inout-params lower to `T*` in C; the callee's references to the identifier become `*name` reads and writes. Existing pointer codegen handles this directly.

### Phase C — Privilege gate (parser + evaluator)

- [ ] Add `pragma` to `BuiltinKeywords` in `src/expr.ts`.
- [ ] Add `Pragma :: enum(AllowUnsafe)` to `std/prelude.yo`.
- [ ] Parse `pragma(Pragma.AllowUnsafe);` at top-of-file. Argument must be comptime-known. Multiple declarations OK.
- [ ] At parse time, compute each file's privilege from its top-of-file pragmas only — **no path-based defaulting**.
- [ ] In the evaluator, gate the unsafe-capable constructs on the current file's privilege:
  - `*(T)` type usage (declarations or expressions evaluating to `*(T)`-typed values)
  - `&(expr)` operator
  - `unsafe(...)` builtin (only callable inside privileged files)
  - `asm(...)` builtin
  - `extern fn` declaration
  - Pointer arithmetic operators (`&+`, `&-`, `&/`, `&<`, `&>`, `&<=`, `&>=`, `&==`, `&!=`)
  - `consume(p.* = v)` form
- [ ] Diagnostic messages per the table in "What Safe Code Cannot Do" above.
- [ ] Add `pragma(Pragma.AllowUnsafe);` to every existing file in `std/` and `yo-self/` (no exceptions). Mechanical migration; ~100 files.

### Phase D — Stdlib boundary sweep (`*(Self)` → `inout(self) : Self` and friends)

- [ ] Sweep `std/prelude.yo` for trait method signatures using `(self : *(Self))`. Replace with `(inout(self) : Self)`. Canonical example: the `Hash` trait —

  ```rust
  // Before:
  Hash :: trait(
    hash : (fn(self : *(Self)) -> u64)
  );

  // After:
  Hash :: trait(
    hash : (fn(inout(self) : Self) -> u64)
  );
  ```

  Most existing `*(Self)` receivers are the same case (pass-by-reference to avoid copying / RC dup; callee may read or write).

- [ ] Sweep `std/` for `*(T)` in other public method signatures. Replace with:
  - `Slice(T)` for borrow-style views (already safe, bounds-checked indexing)
  - `inout(name) : T` for in-place mutation
  - `object` / `Iso(T)` / `Arc(T)` for ownership-passing
- [ ] Internal unsafe code stays as-is, wrapped in `unsafe(...)`.
- [ ] Lint: `yo check --stdlib-public-safe` fails if any public stdlib API exposes `*(T)`.

### Phase E — Tooling

- [ ] `yo check --unsafe-report` — lists every `unsafe(...)` site in the project (including dependencies), with file:line, surrounding `// SAFETY:` comment, and a quantification of the unsafe surface.
- [ ] `yo audit-unsafe` (optional, LLM-backed) — for each `unsafe(...)` site, run an LLM check against the `// SAFETY:` claim. Outputs pass/fail per site. Useful in CI for projects that want extra assurance.
- [ ] `pragma(Pragma.AllowUnsafe);` files surface in the report — privileged code is visible at a glance.

### Phase F — Tests & docs

- [ ] `tests/safe_user_code.test.yo` — positive (safe code compiles and runs) and negative (each forbidden construct produces the right error).
- [ ] `tests/inout_params.test.yo` — `swap`, `increment`, multi-inout, no-escape rejections.
- [ ] `tests/privilege_pragma.test.yo` — `pragma(Pragma.AllowUnsafe);` enables unsafe constructs; absence of pragma rejects them.
- [ ] Existing `tests/*.test.yo` files that use raw pointers (e.g. `tests/ptr.test.yo`) get `pragma(Pragma.AllowUnsafe);` added at the top during the Phase C rollout. Mechanical migration.
- [ ] Update `docs/{en-US,zh-CN}/DESIGN.md` — pointer section becomes "stdlib-only" with a forward reference to `inout` params for user code.
- [ ] Add `docs/{en-US,zh-CN}/MEMORY_SAFETY.md` — the user-facing memory-safety policy. Covers the privilege model, the safe subset, `inout` params, and how to use FFI through wrappers.
- [ ] Update `.github/instructions/yo-syntax.instructions.md` — `inout` parameter syntax, safe-by-default policy.
- [ ] Update `.github/skills/yo-syntax/syntax-cheatsheet.md` and `yo-core-patterns/core-patterns-cheatsheet.md`.

---

## Open Questions

1. ~~**Privilege gate mechanism.**~~ **Resolved:** pragma-only, no path-based defaulting. Every `std/` and `yo-self/` file declares `pragma(Pragma.AllowUnsafe);` explicitly. One uniform rule across the language.

1a. **Read-only-by-ref modifier `in(name) : T`?** Distinct from `inout(name) : T` (mutable by-ref). Useful for methods like `Hash.hash` that read but don't mutate — `inout(self) : Self` is slightly overly-permissive. **Lean:** start with only `inout` in v1. Add `in` later if patterns demand it. Convention documents read-vs-write intent in the meantime; the calling convention (by-reference, no copy) is the same.

2. **Third-party dependencies.** A project depends on a published package. Is that package treated as safe or unsafe-capable? **Lean:** each package's individual files use their own pragmas / path-based defaults. User-project safety doesn't transitively require dependency safety, but `yo check --unsafe-report` shows the full unsafe surface across all dependencies.

3. **`inout` parameter and closures.** Can a closure body refer to an enclosing inout-param? Three sub-cases:

   - Closure invoked synchronously within the function call (e.g., `iter.each((x) => { inout_param = x; })`) — should be fine, closure cannot escape the call frame.
   - Closure that escapes (stored, returned, sent to a Future) — must not capture a inout-param.
   - Closure of unknown escape behavior — conservatively reject.
     **Lean:** for v1, forbid all closure captures of inout-params. Revisit if real APIs demand the synchronous-callback case.

4. **`inout(...)` parameter chaining.** `fn outer(inout(x) : T) { inner(x); }` where `inner` also has a `inout(...)` parameter. **Lean:** allowed. The inout-ness flows through.

5. **`inout(...)` and method dispatch.** Methods on objects today take `(self : *(Self))` for in-place mutation. Under this design, public methods should take `(inout(self) : Self)`. Migration required across stdlib.

6. **`inout(...)` and value vs. RC receiver.** A `inout(name) : T` where `T` is an `object` type — does it allow mutating the RC handle (rebinding to a different object) or just mutating through it? **Lean:** allow rebinding (caller's variable can be reassigned). This matches Pascal/Nim semantics.

7. **Existing user code that uses `*(T)`.** Pre-this-feature Yo code uses raw pointers in user files freely. Migration path:

   - **(a)** Auto-emit `pragma(Pragma.AllowUnsafe);` at the top of every existing file during a one-shot migration. Preserves behavior, no immediate user action needed. Encourages incremental safe-ification.
   - **(b)** Hard break: existing user files fail to compile until users either add the pragma or migrate to safe constructs.
     **Lean:** (a). Yo is pre-1.0 but breaking everyone's code overnight is still rude.

8. **`pragma(Pragma.AllowUnsafe);` granularity.** Should the pragma be per-file (current proposal) or also per-function / per-block? **Lean:** per-file only for v1. Per-function adds complexity without clear benefit; users who need unsafe operations move them to a dedicated module.

9. **Algebraic effects and privilege.** An effect handler in safe code that resumes with a value coming from unsafe stdlib code — does the unsafety leak through the effect? **Lean:** no. The effect is a value boundary; once the value is in safe code's hands, it's bound by safe code's type system. Same logic as a normal function return.

10. **`asm(...)` removal from safe code is straightforward.** `extern fn` is also straightforward. The tricky one is the privilege gate around the `&(x)` operator — today it's pervasive in tests and tutorials. Migration: each test file that uses `&(x)` either gets `pragma(Pragma.AllowUnsafe);` (if it's testing pointer behavior) or gets refactored to use `inout` params.

---

## Examples

### Idiomatic safe user code

```rust
{ ArrayList } :: import("std/collections/array_list");

main :: (fn() -> unit)({
  list := ArrayList(i32).new();
  list.push(i32(1));
  list.push(i32(2));
  list.push(i32(3));

  total := i32(0);
  for(list.iter(), (item) => {
    total = (total + item);
  });
  printf("total = %d\n", total);
});
```

No pragma, no `&()`, no `*(T)`, no `unsafe(...)`. This is the default user experience.

### In-place mutation with `inout`

```rust
increment :: (fn(inout(x) : i32) -> unit)({
  x = (x + i32(1));
});

main :: (fn() -> unit)({
  counter := i32(0);
  increment(counter);
  increment(counter);
  assert((counter == i32(2)), "counter incremented");
});
```

### Opting into unsafe in a user file

```rust
pragma(Pragma.AllowUnsafe);

raw_swap :: (fn(a : *(i32), b : *(i32)) -> unit)(
  unsafe({
    tmp := a.*;
    a.* = b.*;
    b.* = tmp;
  })
);

main :: (fn() -> unit)({
  x := i32(1);
  y := i32(2);
  raw_swap(&(x), &(y));
});
```

Opt-in is a single line. The file is now responsible for its own safety.

### What gets rejected in safe code

```rust
// In a safe user file:

bad_addr :: (fn() -> *(i32))({          // error: raw pointer types are not available in safe code
  x := i32(42);
  &(x)
});

bad_unsafe :: (fn(p : *(i32)) -> i32)(   // error: raw pointer types are not available in safe code
  unsafe(p.*)                             // (also: 'unsafe(...)' is not available in safe code)
);

bad_extern :: extern_fn("foo", ...);     // error: extern FFI declarations are not available in safe code
```

Each error includes a "use 'inout(...)' parameters" / "use a stdlib wrapper" hint.

### Stdlib internal pattern

```rust
// In std/collections/array_list.yo (unsafe-capable by path):

ArrayList :: (fn(comptime(T) : Type) -> comptime(Type))(
  object(
    _ptr : Option(*(T)),
    _length : usize,
    _capacity : usize
  )
);

impl(forall(T : Type), ArrayList(T),
  get : (fn(self : Self, i : usize) -> Option(T))(
    cond(
      (i >= self._length) => .None,
      true => match(self._ptr,
        .Some(p) => .Some(unsafe((p &+ i).*)),   // SAFETY: i < _length, p points to allocated buffer of _capacity ≥ _length
        .None => .None
      )
    )
  )
);
```

Public signature is safe (`Self`, `usize`, `Option(T)`); internal `*(T)` deref is wrapped in `unsafe(...)` with a `// SAFETY:` comment.

---

## Alternatives Considered

### Origins / lifetimes (`FUTURE_ORIGINS.md`)

Considered and deferred. Adds expressiveness for multi-ref returns and library APIs at the cost of constraint-solver complexity, annotation surface, and LLM struggle. The privilege-gate approach in this document gets equivalent practical safety with far less implementation cost. See `FUTURE_ORIGINS.md` for details.

### `unsafe(...)` marker only (`MEMORY_SAFETY.md`)

The committed baseline. Provides Zig-level safety — unsafe surface visible, no propagation. This plan layers on top: in safe user code, the unsafe surface is _zero_, not just visible. Same machinery in stdlib.

### Full Rust-style borrow checker

Rejected throughout the design discussion. Defeats LLM-friendliness; the cost is not justified by Yo's user audience.

### Remove `*(T)` from the language entirely

Considered and rejected. Stdlib needs raw pointers to build the safe abstractions; FFI requires them for the calling convention. The right line is "user code can't use them," not "no one can."

### Per-function unsafe instead of per-file

Considered. The Rust model — `unsafe fn` and `unsafe { ... }` blocks at function granularity. Rejected because it encourages sprinkling unsafe through user code; the per-file pragma forces users to think "do I really need this whole file to be unsafe-capable?" and most will say no.

---

## What This Does Not Solve

- **Stdlib bugs.** Audit and fuzz coverage are the mitigation, not a formal guarantee. Same as every safe-language stdlib.
- **FFI-related UB.** Calling a C function with the wrong arguments is the caller's (the stdlib wrapper's) problem; safe APIs at the boundary minimize the risk.
- **Logic errors.** Memory safety only prevents UB, not bugs.
- **Resource leaks** beyond what `object` + `___drop` handle. Orthogonal.

---

## Status

**Approved for implementation.** Depends on [`MEMORY_SAFETY.md`](MEMORY_SAFETY.md) (committed).

Resolved decisions:

- ✅ **Privilege gate mechanism** — pragma-only, no path-based defaulting. Every `std/` and `yo-self/` file declares `pragma(Pragma.AllowUnsafe);` explicitly.
- ✅ **Migration of existing user code with `*(T)`** — auto-emit `pragma(Pragma.AllowUnsafe);` at the top of pre-existing files (mechanical migration); hard break later if/when migrating to safe constructs.
- ✅ **`inout` parameter capture in closures** — forbid all closure captures of inout-params for v1. Revisit if real APIs demand non-escaping-closure carve-outs.
- ✅ **Read-only-by-ref modifier (`in(name) : T`)** — defer to v2. v1 ships only `inout`.

Phase ordering (foundation → leaves):

1. **Phase A** — `unsafe(...)` marker per [`MEMORY_SAFETY.md`](MEMORY_SAFETY.md). Lands first. Stdlib gets the wraps.
2. **Phase B** — `inout(...)` parameter form. Independent; can land before or alongside C.
3. **Phase C** — privilege gate + `pragma(Pragma.AllowUnsafe);` builtin + `Pragma` enum in prelude. Add the pragma to every `std/`/`yo-self/` file as part of this phase.
4. **Phase D** — stdlib boundary sweep: `*(Self)` → `inout(self) : Self` in trait signatures, `*(T)` → `Slice(T)`/`inout(name) : T` in other public APIs.
5. **Phase E** — tooling (`yo check --unsafe-report`, optional `yo audit-unsafe`).
6. **Phase F** — tests and docs.

Total implementation cost: ~2–3 weeks across all phases. Substantially less than `FUTURE_ORIGINS.md` (~1–2 months) for materially the same practical safety story.

Next concrete unit of work: Phase B (`inout(...)` parameters) — parser + evaluator + codegen for the modifier. Independent of Phase C and can start immediately.
