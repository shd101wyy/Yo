# Memory Safety: `unsafe(...)`

## Goal

Make Yo's unsafe surface **visible** without introducing a new type system. Raw-pointer dereference, arithmetic, and other operations that can cause undefined behavior must appear inside an explicit `unsafe(expr)` call. Safe code stays safe by construction; unsafe code is auditable by `grep`.

The pitch becomes: **"`object` values are memory-safe; raw pointer operations require `unsafe(...)`; the stdlib's unsafe surface is small and audited."**

This is the same shape as Zig — and Rust's `unsafe` blocks — without the borrow checker complexity.

## Non-Goals

- **No new `&(T)` reference type.** Earlier drafts of this doc proposed second-class references with scope tracking. Rejected: complexity-to-safety ratio is poor for a language that already has `object` for the common case. See [Alternatives](#alternatives-considered).
- **No `unsafe fn` (function coloring).** Only `unsafe(...)` calls at the use site. Unsafety doesn't propagate to callers.
- **No lifetimes, no borrow checker, no aliasing rules.**
- **No changes to `&(x)` semantics.** `&(x)` still returns `*(T)` exactly as today.
- **No changes to `object`, RC, cycle removal, or any existing safety infrastructure.**

---

## Design

### Syntax

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

### What requires `unsafe(...)`

| Operation                   | Example               | Why                                     |
| --------------------------- | --------------------- | --------------------------------------- |
| Pointer dereference (read)  | `p.*`                 | May read freed/invalid memory           |
| Pointer dereference (write) | `p.* = v`             | May write through dangling ptr          |
| `consume(p.* = v)`          | initialization-assign | Same as write deref                     |
| Pointer arithmetic          | `p &+ n`, `p &- n`    | Result usually destined to deref        |
| Pointer difference          | `p &/ q`              | Assumes both point into the same object |

### What stays safe

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

The principle: **moving an address around is safe; dereferencing or computing into one isn't.** This matches what an LLM intuitively expects.

### `unsafe(...)` is not a function attribute

A function with `*(T)` in its signature is callable from safe code. The `unsafe(...)` lives in the **body**, exactly where deref happens. This keeps the safety surface visible at the point of risk and prevents unsafety from virally annotating every API that takes a pointer. There is no `unsafe fn`; only the expression-level call.

```rust
// Public API — no unsafe needed at the call site:
parse :: (fn(buf : *(u8), len : usize) -> Option(Header))(
  unsafe(cond(
    (len < usize(16)) => Option(Header).None,
    true => {
      magic := buf.*;
      Option(Header).Some(Header(magic : magic))
    }
  ))
);

main :: (fn() -> unit)({
  data := [u8(0x7f), u8(0x45), u8(0x4c), u8(0x46)];
  match(parse(*(u8)(&(data(usize(0)))), usize(4)),
    .Some(h) => process(h),
    .None => log("bad header")
  );
});
```

---

## Standard Library Migration

The stdlib currently performs pointer deref/arithmetic without ceremony. Each site needs an `unsafe(...)` wrap. No semantic change — just the marker.

### Scope

Rough counts from `grep -rn '\.\*\|&+\|&-\|&/' std/`:

- `std/prelude.yo` — `Array`, `Slice`, `String`, `StringBuilder`, iterators
- `std/collections/*.yo` — every collection's internal pointer manipulation (~10 files)
- `std/imm/*.yo` — immutable variants (~5 files)
- `std/sys/*.yo`, `std/fs/*.yo` — OS buffers, system calls (~15 files)
- `std/string.yo`, `std/template_string.yo` — byte iteration

Estimated: ~200–400 sites need wrapping. Mechanical — most are 1-line `p.*` reads inside an existing function body.

### Pattern

The minimal wrap is the deref expression itself:

```rust
// Before:
value := self._ptr.* &+ self._index;

// After:
value := unsafe((self._ptr &+ self._index).*);
```

Or wrap the enclosing block when the whole body is pointer-y:

```rust
// Before:
next : (fn(self : *(Self)) -> Option(*(T)))(
  cond(
    (self._index >= self._length) =>.None,
    true => {
      ptr := (self._buf &+ self._index);
      self._index = (self._index + usize(1));
      .Some(ptr)
    }
  )
)

// After:
next : (fn(self : *(Self)) -> Option(*(T)))(
  unsafe(cond(
    (self._index >= self._length) =>.None,
    true => {
      ptr := (self._buf &+ self._index);
      self._index = (self._index + usize(1));
      .Some(ptr)
    }
  ))
)
```

Note: the `cond` arm above has pointer arithmetic (`&+`) but no deref — the wrap is for the arithmetic operator. Pointer movement and pointer reads are _both_ gated on `unsafe(...)`.

### Convention

- Prefer wrapping the smallest expression that contains the unsafe op. Reviewers can see the surface at a glance.
- A whole-function `unsafe(...)` wrap is acceptable when the function is fundamentally a thin wrapper over raw memory (e.g. `Slice.get_raw`, allocator primitives).
- Public APIs should be safe at the call site whenever possible — push the `unsafe(...)` into the implementation.

---

## Implementation Phases

### Phase 1 — Parser & evaluator

- [ ] Add `unsafe` to `BuiltinKeywords` in `src/expr.ts`.
- [ ] Parse `unsafe(expr)` as a regular builtin call. No new grammar.
- [ ] In the evaluator, add an `unsafeContext: boolean` flag on the evaluation context. Push `true` when entering `unsafe(...)`, restore on exit.
- [ ] Gate the following operations: emit `error: <op> requires 'unsafe(...)'` if the context flag is false.
  - Pointer deref (`.*` on a `*(T)`)
  - `consume(p.* = v)` where `p : *(T)`
  - `&+`, `&-`, `&/` operators
- [ ] Pointer comparison (`&<`, `&>`, `&==`, `&!=`, `&<=`, `&>=`) stays safe — addresses are just data.

### Phase 2 — Codegen

- [ ] `unsafe(expr)` lowers to its inner expression. Pure compile-time marker.

### Phase 3 — Stdlib audit & migration

- [ ] Sweep `std/` for `.*` deref, `&+`/`&-`/`&/` arithmetic, and `consume(p.* = ...)` calls.
- [ ] Wrap each site. Run the full test suite (`./yo-cli test --bail`) after each module.
- [ ] Same migration on `yo-self/` (the bootstrap compiler — same pattern).

### Phase 4 — Tests & docs

- [ ] `tests/unsafe.test.yo` — `unsafe(...)` accepts deref/arithmetic; missing `unsafe(...)` produces the right error; nesting works; `unsafe(...)` inside an `unsafe(...)` is allowed (no double-wrap warning).
- [ ] Negative tests: each gated op produces the expected error message outside `unsafe(...)`.
- [ ] Update `docs/{en-US,zh-CN}/DESIGN.md` pointer section to introduce `unsafe(...)`.
- [ ] Add `docs/{en-US,zh-CN}/MEMORY_SAFETY.md` — short page summarizing the policy.
- [ ] Update `.github/instructions/yo-syntax.instructions.md` with the `unsafe(...)` rule.
- [ ] Update `.github/skills/yo-syntax/syntax-cheatsheet.md`.

### Phase 5 — Linter / `yo check` integration (optional)

- [ ] Add a "unsafe surface report" — `yo check --unsafe-report` lists every `unsafe(...)` site in the current crate. Useful for security review and for advertising the size of Yo's unsafe surface.

---

## Open Questions

1. **`extern fn` bodies.** Foreign function declarations have no body, so they can't contain `unsafe(...)`. Calling an `extern fn` from safe code is fine (the C side is opaque). Should we require `unsafe(extern_call(...))` at call sites? **Lean: no.** Calling a C function isn't intrinsically UB — the C function defines its own contract.

2. **`asm(...)` blocks.** Already inherently unsafe. **Lean: no `unsafe(asm(...))` requirement.** Document that `asm` is implicitly unsafe.

3. **`consume(...)` semantics.** Today `consume(p.* = v)` means "init, don't drop the old value." It contains a deref-write, so the gating rule says it needs `unsafe(...)`. Confirm this is what we want — alternative would be to treat `consume` as its own gated builtin.

4. **Error message tone.** When the LLM/user writes `p.*` outside `unsafe(...)`, the error should suggest the wrap and explain why. Sample: `error: pointer dereference requires 'unsafe(...)'. Wrap as: unsafe(p.*). Raw pointer ops may dereference invalid memory; see docs/MEMORY_SAFETY.md.`

5. **`*(T)` to `*(U)` casts.** Pointer-type casts (`*(u8)(p)`) are address-preserving and currently unrestricted. **Lean: stays safe.** The unsafety is in eventual deref, not in the cast.

6. **Existing tests in `tests/`.** Tests that exercise raw pointers (e.g. `tests/ptr.test.yo`) will need `unsafe(...)` wraps. Mechanical migration. Track in Phase 3.

---

## Examples

### Idiomatic safe code (unchanged)

```rust
main :: (fn() -> unit)({
  list := ArrayList(i32).new();
  list.push(i32(1));
  list.push(i32(2));
  list.push(i32(3));
  for(list.iter(), (x) => {
    printf("%d\n", x.*);   // x is *(i32) — but this requires unsafe (see below)
  });
});
```

The `x.*` inside the `for` body actually requires `unsafe(...)` under this proposal — see the next example for the post-migration form.

### After migration

```rust
main :: (fn() -> unit)({
  list := ArrayList(i32).new();
  list.push(i32(1));
  list.push(i32(2));
  list.push(i32(3));
  for(list.iter(), (x) => {
    printf("%d\n", unsafe(x.*));
  });
});
```

The `for` loop yields a `*(T)`, and the body needs to deref to print. This is a regression in ergonomics for users iterating with `iter()`. **Mitigations:**

- Add a `each_value` / `for_each` helper that auto-derefs and yields `T` by value (calls `unsafe(x.*)` internally once).
- Or: introduce a value-yielding iterator variant alongside the pointer one (parallel to `into_iter()`'s by-value `Item : T`).

This is a real ergonomic tax. **Worth flagging to the user**: every existing `for(list.iter(), (p) => p.*)` pattern will need either a wrap or a helper. The volume of churn in user code is the main downside of this proposal.

### `unsafe(...)` for a whole function body

```rust
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

### Caller of an unsafe-bodied function — no wrap needed

```rust
main :: (fn() -> unit)({
  msg := "hello";
  n := strlen(*(u8)(msg));   // safe call site; strlen handles its own unsafe
  printf("%zu\n", n);
});
```

---

## Alternatives Considered

### Second-class references `&(T)` with scope tracking

Earlier drafts proposed `&(T)` as a compile-time-checked reference with rules like "containment makes you second-class" and "returned refs must come from arguments." See git history of this file.

Rejected because:

- Yo's `object` already covers the dominant use case (safe shared ownership with cycle removal). The marginal value of `&(T)` over `object`-with-RC is mostly _performance_, not safety.
- The breaking change to `&(x)` semantics (today `&(x) : *(T)`, would become `&(x) : &(T)`) ripples through every existing test and user file.
- Implementing scope tracking in the evaluator is a non-trivial new pass.
- Iterator structs and stdlib APIs would all need migration to two parallel forms (pointer and ref).
- LLMs trained on C and Rust handle raw pointers reasonably well; the marginal LLM-error reduction from adding `&(T)` is small.

### Full Rust-style borrow checker

Lifetimes, aliasing-XOR-mutation, regions. Rejected: defeats the LLM-friendliness goal. Borrow checker errors are notoriously hard to recover from without specific training.

### Nothing — status quo

Rejected because raw pointer ops currently look syntactically identical to safe code. An `unsafe(...)` marker is the minimum viable safety signal for both human reviewers and LLMs.

### Linter-only (`yo check` warns on unsafe ops)

Considered. Rejected because a warning that doesn't block compilation is easy to ignore and easy for an LLM to leave in place. A hard error forces the writer to acknowledge the unsafe surface.

---

## What This Does Not Solve

- **Use-after-free of pointers to local variables.** A function that does `unsafe(return(&(local)))` (well, the equivalent — pointer construction is safe, deref later is the UB) still compiles. The deref site will be in `unsafe(...)`, which is the signal to audit. Catching UAF structurally requires `&(T)` with scope tracking, which we explicitly chose not to add.
- **Pointer arithmetic past array bounds.** Same — `unsafe(p &+ n)` is permitted; bounds are the programmer's problem.
- **Data races across threads.** `Send` / `Iso(T)` / `Arc(T)` handle this; orthogonal.
- **Resource leaks** (FDs, sockets) — covered by `object` + `___drop`. Orthogonal.

The honest framing: **`unsafe(...)` makes the unsafe surface auditable, not impossible.** Combined with `object` being the default for ownership, this gets Yo to roughly Zig's safety level — strictly better than C, strictly weaker than Rust.

---

## Status

Draft for review. Single blocking decision:

- Confirm the ergonomic tax on `for(list.iter(), (p) => unsafe(p.*))` is acceptable, or commit to adding `each_value` / value-yielding iterator variants in Phase 3 to soften it.

No other gating questions. Phase 1 is ~1 day of evaluator work; Phase 3 stdlib migration is the bulk of the effort (~1–2 days of mechanical wrapping plus test fixes).
