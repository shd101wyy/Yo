# Memory Safety

## Goal

Make Yo memory-safe **for user code, by construction.** Two layered mechanisms:

1. **`unsafe(...)` marker** — every operation that could cause undefined behavior (pointer deref, arithmetic, `consume(p.* = v)`) must appear inside an explicit `unsafe(expr)` call. Makes the unsafe surface visible and greppable.

2. **Per-file privilege gate** — files default to **safe** mode where raw pointers, `unsafe(...)`, `asm(...)`, and `extern fn` are all unavailable. Files opt into unsafe-capability with a top-of-file `pragma(Pragma.AllowUnsafe);` declaration. User code defaults safe; stdlib explicitly opts in.

The pitch: **"User code cannot violate memory safety. The unsafe surface is confined to files that explicitly opt in via pragma — primarily stdlib — which is small, audited per release, and fuzz-tested. FFI is wrapped in safe APIs."**

This is Swift's model. It's Go's model. It's Java's model. All three are widely accepted as memory-safe.

## Non-Goals

- **No `&(T)` reference type, no Origins, no lifetimes.** See [`FUTURE_ORIGINS.md`](FUTURE_ORIGINS.md) for the deferred design.
- **No `unsafe fn` (function coloring).** Only `unsafe(...)` expression calls at the use site. Unsafety doesn't propagate to callers.
- **No borrow checker, no aliasing rules.**
- **No changes to `&(x)` semantics.** `&(x)` still returns `*(T)` exactly as today (and is forbidden in safe code by the privilege gate, not by a semantic change).
- **No changes to `object`, RC, cycle removal, or any existing safety infrastructure.**
- **No restrictions on what user code can _call_** — every stdlib function remains callable. Restrictions apply to what user code can _write_: which types it can declare, which operators it can use, which constructs appear in its source.
- **No formal soundness proof.** Safety is achieved by removing the constructs that cause UB from the user's vocabulary; the claim is "user code cannot express UB," not "the type system proves UB-freedom."

---

## Design

### `unsafe(...)` Marker

`unsafe(...)` is a regular builtin call that takes **exactly one expression** — the same shape as `return(...)`, `consume(...)`, etc. The argument can be any expression: a deref, an assignment, a `cond`, a `match`, or a multi-statement begin-block.

```rust
// Single expression — most common form:
v := unsafe(p.*);

// Assignment expression:
unsafe(p.* = i32(12));

// cond / match wrapped directly (NO braces — { without ; is a struct literal):
result := unsafe(cond(
  (len < usize(16)) => Option(Header).None,
  true => Option(Header).Some(parse_inner(buf))
));

// Multi-statement begin-block — note semicolons are required to make it a block:
do_stuff :: (fn(p : *(i32)) -> i32)(
  unsafe({
    p.* = (p.* + i32(1));
    p.*
  })
);
```

`unsafe(...)` is a compile-time marker only. At codegen time it lowers to its argument expression — no runtime cost.

**Reminder on `{...}` shape:** in Yo, `{ expr }` without semicolons is a **struct literal**, not a block. Write `unsafe(expr)` directly for a single expression. Only use `unsafe({ stmt; stmt; result })` when you genuinely need a sequence.

#### What requires `unsafe(...)`

| Operation                   | Example               | Why                                     |
| --------------------------- | --------------------- | --------------------------------------- |
| Pointer dereference (read)  | `p.*`                 | May read freed/invalid memory           |
| Pointer dereference (write) | `p.* = v`             | May write through dangling ptr          |
| `consume(p.* = v)`          | initialization-assign | Same as write deref                     |
| Pointer arithmetic          | `p &+ n`, `p &- n`    | Result usually destined to deref        |
| Pointer difference          | `p &/ q`              | Assumes both point into the same object |

#### What stays safe (no `unsafe(...)` wrap needed)

| Operation                    | Example                     | Why                                |
| ---------------------------- | --------------------------- | ---------------------------------- |
| Take an address              | `&(x)`                      | Producing an address is harmless   |
| Pass `*(T)` to a function    | `foo(&(x))`                 | Caller doesn't deref               |
| Store `*(T)` in a struct     | `Iter(_ptr : *(T), ...)`    | Storing data isn't UB              |
| Return `*(T)`                | `(fn() -> *(T))(...)`       | Same                               |
| Pointer comparison           | `(p &< q)`, `(p &== q)`     | Comparing addresses is harmless    |
| Cast pointer types           | `*(u8)(p)`                  | Casting an address is harmless     |
| Cast `comptime_string` → ptr | `*(u8)("hello")`            | Already supported, stays safe      |
| `asm(...)` blocks            | `asm("..." : : : "memory")` | Implicitly unsafe — no wrap needed |

The principle: **moving an address around is safe; dereferencing or computing into one isn't.**

#### `unsafe(...)` is not a function attribute

A function with `*(T)` in its signature is callable from any unsafe-capable file. The `unsafe(...)` lives in the **body**, exactly where deref happens. This keeps the safety surface visible at the point of risk and prevents unsafety from virally annotating every API that takes a pointer. There is no `unsafe fn`; only the expression-level call.

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

| Construct                                                                        | Diagnostic                                                                                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Declaring a parameter, field, or return of type `*(T)`                           | `error: raw pointer types are not available in safe code. Use 'object', 'Slice(T)', or 'ref(...)' parameters.` |
| Writing an expression with type `*(T)` (e.g. `&(expr)`, `slice._ptr`, `*(T)(x)`) | `error: this expression has type '*(T)', which is not available in safe code.`                                 |
| Calling a function whose return type is `*(T)`                                   | rejected at the call site (the result expression would have type `*(T)`)                                       |
| `unsafe(...)` call                                                               | `error: 'unsafe(...)' is not available in safe code. This operation requires 'pragma(Pragma.AllowUnsafe);'.`   |
| `asm(...)` block                                                                 | `error: inline assembly is not available in safe code.`                                                        |
| `extern fn` declaration                                                          | `error: extern FFI declarations are not available in safe code. Call stdlib wrappers (e.g. 'std/sys').`        |
| Pointer arithmetic operators (`&+`, `&-`, `&/`, etc.)                            | `error: pointer arithmetic requires raw pointers, which are not available in safe code.`                       |
| `consume(p.* = v)` on a pointer deref                                            | `error: 'consume' on a pointer deref requires raw pointers, which are not available in safe code.`             |

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

To recover the in-place-mutation pattern (`swap`, `increment`, etc.) without introducing references as a first-class concept, safe code gets an `inout` parameter form, modeled on Pascal / Nim / C#'s `ref` / Swift's `inout`:

```rust
swap :: (fn(ref(a) : i32, ref(b) : i32) -> unit)({
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

- An `inout` parameter is **pass-by-reference** at the calling convention level (compiles to a `T*`).
- Inside the callee, the identifier `a` behaves like a binding to the caller's variable: reading gives the current value, writing updates it.
- **Non-escape is enforced syntactically.** An inout-param identifier may appear:
  - On the right-hand side of an expression (deref)
  - On the left-hand side of an assignment
  - As an argument to another function's `inout` parameter
  - Nowhere else.
- The following are compile errors:
  - Returning an inout-param as a binding (returning its value is fine; "returning the binding" is impossible because `ref(...)` is not a type)
  - Storing an inout-param in a `let`-binding (`r := a` copies the value, which is fine; you cannot bind to the reference itself)
  - Capturing an inout-param in a closure (most closure forms — see Open Question 3)
  - Putting an inout-param into a struct field (no syntax for this; `ref(...)` is a parameter-only modifier)

This is essentially "second-class references restricted to parameter syntax." Because there's no `inout` _type_, only an `inout` _parameter modifier_, the non-escape rule is trivially enforced — there's no way to write down a value of "inout type" that could escape.

#### `ref(...)` Parameter Syntax

Yo's parameter modifiers follow a uniform shape: the modifier wraps the parameter name as a function-call-style annotation, then the type annotation follows. This matches the existing `own(name) : Type` pattern (used pervasively in `std/prelude.yo` and `std/imm/`):

```rust
fn(ref(name) : Type, ...) -> Return
fn(own(name) : Type, ...) -> Return         // existing — consumes the argument
```

Type annotation is required (same as regular parameters). Multiple `ref(...)` params are allowed in any position. `ref(...)` and `own(...)` are mutually exclusive on the same parameter.

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

The inout-ness is part of the `Fn(...)` signature that `each_mut` expects, not something the caller writes — `=>` parameters can't carry annotations. Inside the closure body, `x` behaves as an inout-binding (assignment writes through to the element's storage). With inlining, this matches the performance of a pointer-iterator loop.

`IteratorMut` trait sketch:

```rust
IteratorMut :: trait(
  Item : Type,
  each_mut : (fn(self : Self, f : Impl(Fn(ref(x) : Self.Item) -> unit)) -> unit)
);
```

#### Migration plan for stdlib iterators

- **`iter()` on every collection** — return a value iterator yielding `T`. Replaces the current `*(T)`-yielding form.
- **`into_iter()`** — already value-yielding; unchanged.
- **`indices()`** — add on indexable collections (`Array`, `Slice`, `ArrayList`, `String` for byte indices).
- **`each_mut(...)`** — add on every collection that supports mutation. Internally uses `*(T)` + `unsafe(...)`; externally takes an `inout`-parameterized closure.
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

- **Yo's ownership analysis** already elides many RC dup/drop pairs (see `plans/RC_OWNERSHIP_IMPLEMENTATION.md`). For typical iteration patterns the per-yield RC traffic is often zero.
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

- **Allowed in public stdlib signatures:** all the safe types listed above, plus `ref(name) : T` parameters where in-place mutation is the right ergonomics.
- **Forbidden in public stdlib signatures:** `*(T)`. Stdlib internals can use raw pointers; the public surface cannot expose them.

The boundary is enforced by a lint (`yo check --stdlib-public-safe`), not by the type system. A stdlib API that returns `*(T)` is technically legal but flagged in CI.

### FFI

User code cannot declare `extern fn`. To call a C function, user code calls a stdlib wrapper:

```rust
// In std/sys/process.yo (pragma(Pragma.AllowUnsafe);):
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

Under this design, closures in user code can only capture safe types. Since `*(T)` doesn't exist in user code, the UAF-via-closure-capture pattern is **structurally impossible.** A closure capturing an `object` handle is fine (RC handles lifetime); a closure capturing a value type is fine (copied at capture); there is no third option.

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

The rollout is incremental. Phase A is the foundation (`unsafe(...)` marker); Phases B and C can land in either order. Phase D depends on B and C both being in.

### Phase A — `unsafe(...)` marker

- [x] Add `unsafe` to `BuiltinFunctions` in `src/expr.ts`. (Adjusted from BuiltinKeywords — shape matches `consume(expr)`.)
- [x] Parse `unsafe(expr)` as a regular builtin call. No new grammar.
- [x] In the evaluator, add an `unsafeContext: boolean` flag on the evaluation context. Push `true` when entering `unsafe(...)`, restore on exit.
- [x] Gate the following operations: emit `error: <op> requires 'unsafe(...)'` if the context flag is false.
  - Pointer deref (`.*` on a `*(T)`) — in `property-access.ts`
  - `__yo_ptr_add` / `__yo_ptr_sub` / `__yo_ptr_diff` calls — in `_expr.ts` dispatcher. Gates `&+`, `&-`, `&/` transitively (those dispatch through these builtins).
  - `consume(p.* = v)` — gated automatically via the LHS deref evaluation
- [x] Pointer comparison (`&<`, `&>`, `&==`, `&!=`, `&<=`, `&>=`) stays safe — addresses are just data.
- [x] Codegen: `unsafe(expr)` lowers to its inner expression. Pure compile-time marker.
- [x] ~~**MVP adjustment (path-based bypass)**~~ — removed in Phase C; the gate now consults a per-file registry populated by `pragma(...)` calls. `auto-generated://...` URIs remain as a transitive bypass (macro/derive expansions inherit privilege from their callsite).
- [x] `tests/unsafe.test.yo` — 8 positive tests for `unsafe(...)`: read/write/arithmetic deref, begin-block, transparency, nesting, cond/match wrap.
- [x] `src/tests/unsafe-gate.test.ts` — 4 negative tests verifying the gate errors fire on (a) bare deref without unsafe, (b) bare pointer arith without unsafe, (c) `unsafe(...)` without pragma, (d) the positive case where pragma + unsafe wrap compiles cleanly.

### Phase B — `ref(...)` parameters

- [x] Parse `ref(name) : T` in function parameter lists. Added alongside `own(name)` in src/evaluator/types/function.ts. Combinations with `own` or `comptime`/forall are rejected.
- [x] In the evaluator, treat inout-params as bindings to the caller's storage. Marked the parameter and env-side variable with `isInout` (FunctionParameter + Variable). Mark variables `isReassignable: true` so assignments inside the callee body type-check.
- [x] Codegen: inout-params lower to `T*` in C. Three changes:
  - `src/codegen/functions/declarations.ts`: signature emits `T* name`.
  - `src/codegen/exprs/atom.ts`: variable reads return `(*name)` (three lookup paths — main, state-machine, and the fallback used by assignment-LHS).
  - `src/codegen/exprs/other-fn-call.ts`: at the call site, args for inout params are wrapped in `(&(arg))`; the cast-to-param-type uses `T*`. Wrap folds `(&(*x))` → `x` so passing through nested inout calls doesn't accumulate `&(*` indirection.
- [x] `tests/inout_params.test.yo` — 6 tests: swap, increment, inout+value mix, double-inout (both params written), inout chained through another inout-param fn, and inout-read returning the caller's current value.
- [x] **Non-escape enforcement (closure captures).** Closures (`=>` form) that capture an `inout` parameter from an enclosing function are now rejected at evaluation time with `Cannot capture inout parameter 'x' in a closure. \`ref(x) : T\` is a second-class reference …`. Implemented in `src/evaluator/values/anonymous-function.ts`immediately before`enrichCapturedVariables`— for each captured variable in an outer frame, the gate consults the variable's`isInout`flag and throws if set. Per Open Question 3, even the synchronous-callback case is forbidden in v1. Tests pinned in`tests/inout*closure_capture.test.yo`via`comptime_expect_error(...)` (read-capture, write-capture, nested-closure capture, plus a positive runtime test that a closure not touching any inout param still compiles and runs). Other escape vectors (`r := inout_param` binding, struct field) are structurally impossible: there's no syntax for an "inout type", only an inout \_parameter modifier*, so a let-binding copies the value (fine) and a struct field can't name the binding.

### Phase C — Privilege gate

- [x] Add `pragma` to `BuiltinFunctions` in `src/expr.ts` (adjusted from BuiltinKeywords; same precedent as `consume`, `unsafe`).
- [x] Add `Pragma :: enum(AllowUnsafe)` to `std/prelude.yo`, plus `pragma(Pragma.AllowUnsafe);` for the prelude itself.
- [x] Parse `pragma(Pragma.AllowUnsafe);` as a regular builtin call. Argument shape recognized at the AST level (`.` property-access of `Pragma` and `AllowUnsafe`) so the prelude can declare its own pragma without resolving the enum.
- [x] At evaluator time, compute each file's privilege from its `pragma(...)` calls only — **no path-based defaulting**. See `src/evaluator/memory-safety.ts`.
- [x] In the evaluator, gate `unsafe(...)` itself on the calling file's privilege. Without `pragma(Pragma.AllowUnsafe);`, `unsafe(...)` is a compile error.
- [x] Bulk-add the pragma to every existing file in `std/`, `yo-self/`, and `tests/` via `scripts/add-pragma.ts` (633 files).
- [x] **Structural gates landed.** Safe code (no pragma) now rejects every construct that can name or produce a raw pointer:
  - `*(T)` type expressions — gated in `src/evaluator/calls/pointer.ts:evaluateRawPointerCall`. Fires on parameter, field, and return-type slots, plus any standalone `*(T)` declaration.
  - `&(expr)` address-of — gated in `src/evaluator/builtins/ptr-fns.ts:evaluateAddressCall`. Fires at the construction site, so the diagnostic points at the `&` rather than at a downstream use.
  - `asm(...)` builtin — already gated in `src/evaluator/builtins/asm.ts`.
  - `extern(...)` declarations — already gated in `src/evaluator/exprs/extern.ts`.
  - Pointer arithmetic operators (`&+`, `&-`, `&/`) — already gated in `src/evaluator/exprs/_expr.ts`. Pointer comparison (`&==`, `&<`, …) intentionally stays safe per design — comparing addresses can't violate memory safety.
  - `consume(p.* = v)` — gated transitively via the inner `.* ` deref gate in `property-access.ts`.
  - Pragma re-added by `scripts/add-pragma-for-pointer-decls.ts` to every file under `std/`, `yo-self/`, and `tests/` whose source mentions `*(...)` or `&(...)`. The trim pass (`scripts/trim-pragma.ts`) had removed it from files using only pointer-type declarations; the new structural gates require it everywhere a raw-pointer-typed expression appears.
- [x] **Diagnostic messages match the "What Safe Code Cannot Do" table.** Each gate's error names the rejected construct, suggests the safe alternative (Slice(T), ref(name) : T, stdlib wrapper), and tells the user how to opt into unsafe-capability if they really need it. Tests in `tests/safe_code_structural_gates.test.yo` (`comptime_expect_error` for each of the five structural rejections + a positive runtime guardrail using `inout`) and `src/tests/unsafe-gate.test.ts`.
- [x] Add `pragma(Pragma.AllowUnsafe);` to every file in `std/`, `yo-self/`, and pointer-using `tests/*.test.yo` that needs it. Bulk-applied by `scripts/add-pragma.ts`, then trimmed by `scripts/trim-pragma.ts` to ~265 files (down from 633 — the initial bulk pass was deliberately over-inclusive).
- [x] `tests/privilege_pragma.test.yo` — pragma enables unsafe constructs (deref, write-deref, pointer arithmetic, transparent block wrap). The negative direction (pragma absent) lives in `src/tests/unsafe-gate.test.ts`.
- [x] `tests/safe_user_code.test.yo` — positive: safe code (arithmetic, cond/match, Option/Result, String/collections, `ref(...)` params, higher-order fns) compiles and runs WITHOUT the pragma. Negative side covered by `src/tests/unsafe-gate.test.ts` and `src/tests/pragma-validation.test.ts`.

### Phase D — Stdlib boundary sweep (`*(Self)` → `ref(self) : Self` and friends)

- [x] **Hash trait migrated.** Trait signature + all primitive impls in std/prelude.yo. Plus `__derive_hash` macro, String, imm.String. Pattern:

  ```rust
  // Before:
  Hash :: trait(
    hash : (fn(self : *(Self)) -> u64)
  );

  // After:
  Hash :: trait(
    hash : (fn(ref(self) : Self) -> u64)
  );
  ```

- [x] **Clone trait migrated.** Same shape. Trait + all primitive impls + Box(T) + Option(T) + Result(T,E) + `__derive_clone` macro + ArrayList + HashMap + String. Bulk-migration of `(&(x)).clone()` → `x.clone()` in yo-self/ via `scripts/migrate-clone-calls.ts` (29 files).
- [x] **Eq, PartialEq, Ord** — checked. Already take parameters by value (`lhs : Self, rhs : Rhs`); no migration needed.
- [ ] **Iterator trait** — explicitly skipped per goal ("Let's not change Iterator for now"). Iterator methods still take `(self : *(Self))` and yield `*(T)`. Migrating them would also require redesigning the for-loop interaction (see plan's "Iteration in safe code" section).
- [x] **ToString trait migrated** — trait declaration in `std/fmt/to_string.yo` plus all 28 impls (including primitives whose bodies use `self` as a bare value via `snprintf(..., "%llu", self)`, char, str, rune, String) now take `ref(self) : Self`. The `__derive_tostring` macro emits the same shape. The codegen bug that previously blocked this — `T self = (*self);` shadow on inout-param multi-statement bodies — was fixed earlier in the project (commit `d27044b1`).
- [x] **Inherent-method `*(Self)` migrations** — bulk-migrated where `self` is only used for field access (`self.field`), not as a bare value:
  - `yo-self/emitter.yo` — 9 sigs, drops pragma
  - `yo-self/codegen/context.yo` — 83 sigs, 171 `self.*` rewrites (pragma stays for unrelated array-element writes)
  - `yo-self/evaluator/builtins/build.yo` — 27 sigs, 55 rewrites
  - `yo-self/parser.yo` — 19 sigs
  - `yo-self/env.yo` — 5 sigs
- [x] **Remaining `*(T)` in other public method signatures** — `fnv1a_hash_bytes` and `random_bytes` migrated to take `Slice(u8)`; the `Slice` carries both pointer and length, eliminating the (`ptr`, `wrong-size`) footgun. The rest of the remaining `*(T)` in std/ is either inside `extern(...)` (FFI), inside the `_cstr` family (explicit raw-pointer variants of safe APIs), or named to signal raw-pointer use by contract (`raw_args`, `argv`, `from_raw_parts`, `as_ptr`). The `public-safe-report` lint below verifies the safe surface stays clean.
- [x] **Lint: `yo public-safe-report [path]`** — flags every top-level public `fn(...)` declaration in the scanned tree whose parameters or return type expose `*(T)` outside an `extern(...)` block. Names ending in `_cstr`, `_ptr`, `_raw`, or `from_raw_parts` / `as_ptr` are treated as raw-pointer-API by contract and skipped. Whole files under `libc/`, `linux/`, `darwin/`, `cuda/`, `sys/`, `sync/` are skipped — those are FFI by construction. Currently reports 0 findings on `./std` and `./yo-self`. Source: `src/public-safe-report.ts`; tests: `src/tests/public-safe-report.test.ts`.

### Phase E — Tooling

- [x] `yo unsafe-report [path]` — lists every `unsafe(...)` site, `asm(...)` block, `extern(...)` declaration, and `pragma(Pragma.AllowUnsafe);`-declaring file under the given path. `file:line:col` format for editor jumps. `--json` flag emits machine-readable output. Implemented as a regex-based scanner in `src/unsafe-report.ts`; no parser/evaluator involvement, so it runs fast and works even on broken files.
- [x] Surrounding `// SAFETY:` comments on the previous 3 lines are picked up and printed under the corresponding `unsafe(...)` finding.
- [ ] `yo audit-unsafe` (optional, LLM-backed) — for each `unsafe(...)` site, run an LLM check against the `// SAFETY:` claim. Outputs pass/fail per site. Useful in CI for projects that want extra assurance. **Deferred — not implemented.**

### Phase F — Docs

- [x] Update `docs/{en-US,zh-CN}/DESIGN.md` — pointer section now describes the unsafe(...) marker and the pragma requirement; new "Memory Safety" subsection; `inout` parameter section. Cross-link to `yo unsafe-report`.
- [x] `.github/instructions/yo-syntax.instructions.md` — `inout` parameter syntax, `unsafe(...)` + pragma rule.
- [x] `.github/skills/yo-syntax/syntax-cheatsheet.md` — concise rule lines for `unsafe(...)`, pragma, and `ref(name)`.
- [ ] `docs/{en-US,zh-CN}/MEMORY_SAFETY.md` standalone user-facing page — **deferred.** The plan document itself (this file) plus the DESIGN.md section currently cover the user-facing surface. A standalone page can be split out later if the audience grows.

### Phase G — Unify comment-style directives under `pragma(...)`

Comment-style directives (`// @skip_prelude`, `// @skip_wasm`, …) were the original ad-hoc form for file-level compiler hints. Phase G replaces them with proper `pragma(Pragma.X);` calls so that all file-level flags share one mechanism, get validated against the `Pragma` enum, and surface typos as compile errors instead of silent no-ops.

- [x] Extend `Pragma :: enum(...)` in `std/prelude.yo` with `SkipPrelude`, `SkipWasm`, `SkipWasm32Emscripten`, `SkipWasm32Wasi`.
- [x] Move `Pragma` enum definition to the top of `std/prelude.yo` (right after the foundational `Comptime`/`Runtime` traits, before any extern/asm/pointer-op site) so the prelude's own pragma calls can evaluate against the enum normally.
- [x] Refactor `evaluatePragma` in `src/evaluator/builtins/pragma.ts` to **evaluate** the argument and check it against the `Pragma` enum (`typeName === "Pragma"`, `selectedVariantName` set, recognized variant). This replaces the previous AST-shape token-name match, so typos like `Pragma.AlloeUnsafe` now produce a clear error.
- [x] Add a minimal `preScanForSkipPrelude` AST-shape probe in `src/evaluator/builtins/pragma.ts`, called from `src/evaluator/index.ts` BEFORE the prelude loads. This is the one case where full evaluation isn't possible (the file by definition doesn't have `Pragma` in scope) — kept narrow on purpose.
- [x] Replace `hasSkipDirectiveForTarget`'s text-scan in `src/test-runner.ts` with a `pragma(Pragma.SkipWasm*)` regex over the first 50 lines. The test runner runs before the evaluator, so it stays a text scan — but it now looks for the same syntax the evaluator validates semantically.
- [x] Migrate every `// @skip_prelude` and `// @skip_wasm*` directive in `std/`, `yo-self/`, `src/tests/`, and `tests/` to `pragma(Pragma.X);` via `scripts/migrate-skip-pragmas.ts` (80 directives across 57 files). Comment text inside string literals (e.g. test data in `yo-self/tests/phase6*.test.yo`) is left untouched.
- [x] Remove the now-unused `hasCommentAttribute` helper from `src/evaluator/index.ts`.
- [x] **yo-self port landed.** `yo-self/expr.yo` now defines `BF_PRAGMA` (and `BF_UNSAFE` for forward-compat); new `yo-self/evaluator/builtins/pragma.yo` mirrors `recognizePragmaArgByAstShape` and `preScanForSkipPrelude` from the TS side; `yo-self/evaluator/index.yo` calls `pre_scan_for_skip_prelude(program.clone())` instead of `has_comment_attribute(tokens, "@skip_prelude")`. The legacy helper stays exported but unused by the constructor. Scope: only the `SkipPrelude` pre-scan that must run before prelude loading; full `AllowUnsafe`-pragma gating in yo-self is a separate Phase C port not yet started (current yo-self doesn't gate raw-pointer ops, so pragma gating has no observable behavior to wire to yet).
- [x] Docs: `plans/WASM_SUPPORT.md` and `.github/instructions/testing.instructions.md` rewritten to describe `pragma(Pragma.SkipWasm*)` instead of the old comment directives.

---

## Open Questions

1. **`extern fn` call sites.** Calling an `extern fn` from an unsafe-capable file is fine (the C side is opaque). Should the call site require an explicit `unsafe(extern_call(...))` wrap? **Lean: no.** Calling a C function isn't intrinsically UB — the C function defines its own contract.

2. **`asm(...)` blocks.** Already inherently unsafe. **Lean: no `unsafe(asm(...))` requirement.** Document that `asm` is implicitly unsafe and only available in unsafe-capable files.

3. **`inout` parameter capture in closures.** ✅ Resolved: forbid all closure captures of inout-params in v1, even the synchronous-callback case. Implementation in `src/evaluator/values/anonymous-function.ts`; tests in `tests/inout_closure_capture.test.yo` (`comptime_expect_error` negatives + a positive runtime guardrail). Revisit if real APIs demand the synchronous-callback carve-out.

4. **`ref(...)` and `object` receiver.** An `ref(name) : T` where `T` is an `object` type — does it allow mutating the RC handle (rebinding to a different object) or just mutating through it? **Lean:** allow rebinding (caller's variable can be reassigned). This matches Pascal/Nim semantics.

5. **Read-only-by-ref modifier `in(name) : T`?** Distinct from `ref(name) : T` (mutable by-ref). Useful for methods like `Hash.hash` that read but don't mutate — `ref(self) : Self` is slightly overly-permissive. **Lean:** start with only `inout` in v1. Add `in` later if patterns demand it. Convention documents read-vs-write intent in the meantime; the calling convention (by-reference, no copy) is the same.

6. **`*(T)` to `*(U)` casts.** Pointer-type casts (`*(u8)(p)`) are address-preserving and currently unrestricted. **Lean: stays safe** within unsafe-capable files; rejected in safe code only because the result expression has type `*(U)`.

7. **`consume(...)` semantics.** Today `consume(p.* = v)` means "init, don't drop the old value." It contains a deref-write, so the gating rule says it needs `unsafe(...)`. Confirm this is what we want — alternative would be to treat `consume` as its own gated builtin.

8. **Error message tone.** Errors must be specific and suggest the fix. Sample: `error: pointer dereference requires 'unsafe(...)'. Wrap as: unsafe(p.*). Raw pointer ops may dereference invalid memory; see docs/MEMORY_SAFETY.md.`

9. **Third-party dependencies.** A project depends on a published package. Is that package treated as safe or unsafe-capable? **Lean:** each package's individual files use their own pragmas. User-project safety doesn't transitively require dependency safety, but `yo check --unsafe-report` shows the full unsafe surface across all dependencies.

10. **`pragma(Pragma.AllowUnsafe);` granularity.** Should the pragma be per-file (current proposal) or also per-function / per-block? **Lean:** per-file only for v1. Per-function adds complexity without clear benefit; users who need unsafe operations move them to a dedicated module.

11. **Algebraic effects and privilege.** An effect handler in safe code that resumes with a value coming from unsafe stdlib code — does the unsafety leak through the effect? **Lean:** no. The effect is a value boundary; once the value is in safe code's hands, it's bound by safe code's type system. Same logic as a normal function return.

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
increment :: (fn(ref(x) : i32) -> unit)({
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
// In a safe user file (no pragma):

bad_addr :: (fn() -> *(i32))({          // error: raw pointer types are not available in safe code
  x := i32(42);
  &(x)
});

bad_unsafe :: (fn(p : *(i32)) -> i32)(   // error: raw pointer types are not available in safe code
  unsafe(p.*)                            // (also: 'unsafe(...)' is not available in safe code)
);

bad_extern :: extern_fn("foo", ...);     // error: extern FFI declarations are not available in safe code
```

Each error includes a "use 'ref(...)' parameters" / "use a stdlib wrapper" hint.

### Stdlib internal pattern — safe public API with unsafe internals

```rust
// In std/collections/array_list.yo:
pragma(Pragma.AllowUnsafe);

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
        // SAFETY: i < _length, _ptr points to allocated buffer of _capacity ≥ _length
        .Some(p) => .Some(unsafe((p &+ i).*)),
        .None => .None
      )
    )
  )
);
```

Public signature is safe (`Self`, `usize`, `Option(T)`); internal `*(T)` deref is wrapped in `unsafe(...)` with a `// SAFETY:` comment.

### Stdlib internal pattern — `unsafe(...)` for a whole function body

```rust
pragma(Pragma.AllowUnsafe);

strlen :: (fn(s : *(u8)) -> usize)(
  unsafe({
    n := usize(0);
    p := s;
    while((p.* != u8(0)), {
      n = (n + usize(1));
      p = (p &+ 1);
    });
    n
  })
);
```

Acceptable when the function is fundamentally a thin wrapper over raw memory.

### Public safe API over unsafe primitive

```rust
pragma(Pragma.AllowUnsafe);

// Internal:
parse_header :: (fn(buf : *(u8), len : usize) -> Option(Header))(
  unsafe(cond(
    (len < usize(16)) => Option(Header).None,
    true => {
      magic := buf.*;
      Option(Header).Some(Header(magic : magic))
    }
  ))
);

// Public safe wrapper (could live in a safe file that re-exports):
parse :: (fn(slice : Slice(u8)) -> Option(Header))(
  parse_header(slice._ptr_unsafe(), slice.length())
);
```

The user-facing `parse` takes a bounds-checked `Slice(u8)`; the internal `parse_header` does the raw work.

---

## Alternatives Considered

### Origins / lifetimes (`FUTURE_ORIGINS.md`)

Considered and deferred. Adds expressiveness for multi-ref returns and library APIs at the cost of constraint-solver complexity, annotation surface, and LLM struggle. The privilege-gate approach in this document gets equivalent practical safety with far less implementation cost. See `FUTURE_ORIGINS.md` for the deferred design.

### `unsafe(...)` marker alone (no privilege gate)

Earlier draft of this design. Provides Zig-level safety — unsafe surface visible, no propagation, but user code can still write `*(T)` and `unsafe(...)`. This plan layers the privilege gate on top: in safe user code, the unsafe surface is _zero_, not just visible.

### Full Rust-style borrow checker

Rejected throughout the design discussion. Defeats LLM-friendliness; the cost is not justified by Yo's user audience.

### Second-class references `&(T)` with scope tracking

Earlier drafts proposed `&(T)` as a compile-time-checked reference. Rejected because: (a) `object` already covers the dominant use case (safe shared ownership with cycle removal); (b) the breaking change to `&(x)` semantics ripples through every existing test and user file; (c) implementing scope tracking is a non-trivial new pass; (d) LLMs handle raw pointers reasonably well anyway.

### Remove `*(T)` from the language entirely

Considered and rejected. Stdlib needs raw pointers to build the safe abstractions; FFI requires them for the calling convention. The right line is "user code can't use them," not "no one can."

### Per-function unsafe instead of per-file

Considered. The Rust model — `unsafe fn` and `unsafe { ... }` blocks at function granularity. Rejected because it encourages sprinkling unsafe through user code; the per-file pragma forces users to think "do I really need this whole file to be unsafe-capable?" and most will say no.

### Linter-only (`yo check` warns on unsafe ops)

Considered. Rejected because a warning that doesn't block compilation is easy to ignore and easy for an LLM to leave in place. A hard error forces the writer to acknowledge the unsafe surface.

---

## What This Does Not Solve

- **Stdlib bugs.** Audit and fuzz coverage are the mitigation, not a formal guarantee. Same as every safe-language stdlib.
- **FFI-related UB.** Calling a C function with the wrong arguments is the caller's (the stdlib wrapper's) problem; safe APIs at the boundary minimize the risk.
- **Logic errors.** Memory safety only prevents UB, not bugs.
- **Resource leaks** beyond what `object` + `___drop` handle. Orthogonal.
- **Data races across threads.** `Send` / `Iso(T)` / `Arc(T)` handle this; orthogonal.
- **Pointer arithmetic past array bounds in `unsafe(...)`-capable code.** `unsafe(p &+ n)` is permitted; bounds are the programmer's problem at that point.

The honest framing: **`unsafe(...)` makes the unsafe surface auditable; the privilege gate keeps user code outside it entirely.** Combined with `object` being the default for ownership, this gets Yo to roughly Swift/Go's safety level — strictly better than C, comparable to other widely-adopted memory-safe languages, strictly weaker than Rust.

### Known Limitations & Accepted Trade-offs

The following sharp edges remain after the gates above. They were raised in review and are listed here so future readers don't re-discover them and assume the design overlooks them.

1. **Dangling `Slice(T)` from local arrays — ✅ RESOLVED.** `Slice(T)` is a fat pointer (ptr + length) whose user-visible type doesn't mention `*(T)`. Safe code could previously construct a slice from a stack-allocated array and return it past the array's lifetime:

   ```rust
   make_dangling :: (fn() -> Slice(i32))({
     arr := Array(i32, 3).of(i32(1), i32(2), i32(3));
     arr.as_slice()                 // points into the dying call frame
   });
   ```

   None of the Phase C structural gates caught this — the result expression doesn't have type `*(T)`. Closed by extending the iterator flowability rule to "any returned value whose representation transitively carries a raw pointer (or could provide source storage for one via an `object` arg) must be flowable". See **`plans/SLICE_FLOWABILITY.md`** for the design and **`tests/slice_flowability.test.yo`** for the verdicts. Same shape as Open Question 7 in `plans/ITERATOR_REDESIGN.md` (also resolved).

2. **`extern(...)` call sites must be wrapped in `unsafe(...)` — ✅ RESOLVED.** Every `extern "c"` call must be wrapped in `unsafe(...)` even in `pragma(Pragma.AllowUnsafe);` files. The pragma authorizes DECLARING the FFI symbol; the wrap is the per-call audit marker. `extern(...)` declarations, `c_include(...)` declarations, and `asm(...)` blocks themselves stay unwrapped — the pragma is the right gate for those. See **`plans/EXTERN_UNSAFE_WRAP.md`** for the design and **`tests/extern_unsafe_wrap.test.yo`** for the verdicts.

3. **`asm(...)` blocks similarly carry no `unsafe(...)` wrap requirement** — they are implicitly unsafe by virtue of needing pragma. Same reasoning as #2; the audit story owns the granularity gap.

4. **`pragma(Pragma.AllowUnsafe);` parsing depends on the `Pragma` enum** — which lives in `std/prelude.yo`. The bootstrap issue (the prelude itself declares `pragma(Pragma.AllowUnsafe);`) is solved by `preScanForSkipPrelude` in `src/evaluator/builtins/pragma.ts`: a narrow AST-shape match runs BEFORE the prelude loads, recognizing the literal `Pragma.AllowUnsafe` / `Pragma.SkipPrelude` shapes without resolving identifiers. All other pragma kinds are validated by full evaluation against the enum after the prelude is in scope. This is intentional and load-bearing — typos like `Pragma.AlloeUnsafe` still produce a clear error from the full-evaluation pass.

5. **No `unsafe fn` — no per-call-site safety contract.** A function `(fn(p : *(i32)) -> i32)({ unsafe(p.*) })` carries the unsafety in its _body_, not its _signature_. Callers (inside an unsafe-capable file) write `f(some_ptr)` with no marker at the call site. If the caller passes a dangling pointer, UB happens with no visual signal where the deref occurs. Rust's `unsafe fn` forces the call site to write `unsafe { f(p) }` — Yo deliberately doesn't, per Open Question 1's stance that unsafety doesn't propagate to callers. The trade-off: within an unsafe-capable file, you can't tell at a glance which calls are UB-capable. Mitigation: `yo unsafe-report` flags every `unsafe(...)` site and every privileged file. Acceptable for v1; the audience for `pragma(Pragma.AllowUnsafe);`-bearing files is intentionally small (stdlib + FFI wrappers).

6. **Integer overflow is C UB.** Yo's `i32(...)`, `i64(...)`, etc. compile to C signed integer types, whose overflow is UB in standard C. `x := i32(2147483647); y := (x + i32(1));` is UB in safe Yo code today. Out of scope for the memory-safety plan (this is _arithmetic_ UB, not _memory_ UB), but worth flagging because users will encounter it. Mitigation options: (a) compile with `-fwrapv` so overflow defines as two's-complement wrap; (b) add explicit `wrapping_add` / `checked_add` builtins and lint against raw `+` on signed integers; (c) accept the C-style behavior and document. Lean: (a) as a Yo default flag, (b) as future arithmetic-safety work in a separate plan.

---

## Status

**Phase A + B + C + D (partial) + E + F landed.** User code is memory-safe by construction unless it explicitly declares `pragma(Pragma.AllowUnsafe);` at the top of the file. `ref(name) : T` parameters give in-place mutation without raw pointers. Hash and Clone traits now take `ref(self) : Self` instead of `(self : *(Self))` — user code calling `value.hash()` or `value.clone()` works naturally with no manual `&(...)`. `yo unsafe-report` audits the unsafe surface across a project.

Resolved decisions:

- ✅ **Privilege gate mechanism** — pragma-only, no path-based defaulting. Every `std/`, `yo-self/`, and `tests/` file explicitly declares `pragma(Pragma.AllowUnsafe);` at the top. The previous path-based MVP heuristic has been removed.
- ✅ **Migration of existing user code with `*(T)`** — auto-emit `pragma(Pragma.AllowUnsafe);` at the top of pre-existing files via `scripts/add-pragma.ts` (633 files touched in one mechanical commit).
- ✅ **`inout` parameter capture in closures** — forbid all closure captures of inout-params for v1. Revisit if real APIs demand non-escaping-closure carve-outs.
- ✅ **Read-only-by-ref modifier (`in(name) : T`)** — defer to v2. v1 ships only `inout`.

Phase ordering (foundation → leaves):

1. **Phase A** ✅ — `unsafe(...)` marker. Gates `.*` deref, `&+`/`&-`/`&/` arithmetic, and `consume(p.* = v)`.
2. **Phase B** ✅ — `ref(name) : T` parameter form. Used as the safe in-place-mutation primitive for user code; Phase D will use it to replace `*(Self)` receivers in stdlib trait method signatures.
3. **Phase C** ✅ — privilege gate + `pragma(Pragma.AllowUnsafe);` builtin + `Pragma` enum in prelude. Gates `unsafe(...)`, `asm(...)`, and `extern fn` declarations on the calling file's pragma. Pragma added to every `std/`/`yo-self/`/`tests/` file.
4. **Phase D** ✅ partial — Hash and Clone traits migrated to `ref(self) : Self`; their derive macros updated; ArrayList/HashMap/String impls updated; yo-self bulk migration of `(&(x)).clone()` → `x.clone()` (29 files via script). Iterator trait deferred per goal — would require for-loop redesign. Other one-off `*(T)` signatures (FFI wrappers, `as_ptr`, etc.) left case-by-case.
5. **Phase E** ✅ — `yo unsafe-report` (audit-friendly listing of every unsafe site, asm, extern, and pragma file). `yo audit-unsafe` (LLM-backed) deferred.
6. **Phase F** ✅ — Docs (DESIGN.md en+zh, syntax instructions, cheatsheet, cross-links to `yo unsafe-report`). The standalone `docs/{en-US,zh-CN}/MEMORY_SAFETY.md` user page is deferred; the DESIGN.md + plans/ coverage is sufficient for now.

Total implementation cost: ~2–3 weeks across all phases. Substantially less than `FUTURE_ORIGINS.md` (~1–2 months) for materially the same practical safety story.

**Next concrete unit of work: Iterator trait redesign** (Phase D). The remaining Phase C structural gates (`*(T)` types, `&(expr)`) are also meaningful follow-ups but don't compromise memory safety in practice.

**Known gaps:**

- **(All previously known gaps closed as of this revision.)**
