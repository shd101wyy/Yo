# Slice Flowability — Closing the Dangling-Slice Hole

Status: **Plan — not yet implemented.**

## Problem

`plans/MEMORY_SAFETY.md` Known Limitation #1 documents a structural hole:
`Slice(T)` is a fat pointer (`*(T) + length`) whose **user-visible type
doesn't mention `*(T)`**, so safe code can construct a slice from
local-storage and return it past that storage's lifetime:

```rust
make_dangling :: (fn() -> Slice(i32))({
  arr := Array(i32, 3).of(i32(1), i32(2), i32(3));
  arr.as_slice()                 // points into the dying call frame
});
```

None of the Phase C structural gates catch this — the result expression
has type `Slice(i32)`, not `*(T)`. The same shape is also Open Question
7 in `plans/ITERATOR_REDESIGN.md`.

Equivalent failure modes exist for:

- Returning a sub-slice of a local array: `(fn() -> Slice(i32))(arr(usize(0)..usize(3)))`
- Returning a `str` constructed from local bytes (`str` is a newtype
  over `Slice(u8)`)
- Any custom struct that stores a `Slice(T)` as a field — same
  representation-level escape
- Any future user type wrapping a `Slice(T)`

AddressSanitizer catches this at runtime; the type system currently
does not.

## Non-Goals

- **No lifetimes.** Yo's design deliberately rejects lifetimes (see
  `FUTURE_ORIGINS.md`). This plan does not introduce them.
- **No borrow checker.** Same.
- **No new restrictions on Slice's safe API** — `s.len()`, `s(i)`,
  iteration, indexing, range slicing all stay safe.
- **No restrictions on Slice from heap-owning containers passed by
  reference.** `(fn(ref(list) : ArrayList(i32)) -> Slice(i32))(list.as_slice())`
  stays accepted — the caller's `ArrayList` outlives the return, same
  argument as `ref(T)` flowability.
- **No catch for "caller drops the source after the call returns".**
  That requires lifetimes. Same audit obligation as the rest of
  `plans/MEMORY_SAFETY.md` — see Known Limitation #1.

## Design

### What we extend

The existing flowability rule (`src/evaluator/types/flowability.ts`,
implemented for Phase B of `plans/ITERATOR_REDESIGN.md`) applies at:

1. The return expression of a `-> ref(T)`-returning function.
2. The RHS of a `ref(name) := expr;` local binding.

We add a third enforcement site:

3. **The return expression of any function whose return type
   transitively carries a raw pointer (`*(T)`) in its representation
   but is not itself `-> ref(T)`.** Currently this covers `Slice(T)`
   and `str` (which is `newtype(bytes : Slice(u8))`), plus any user
   type that stores a `Slice` field, transitively.

When this rule fires, the return expression must satisfy the same
R1–R4 flowability predicate that already exists for `ref(T)` returns.

### The predicate — what counts as "transitively contains a raw pointer"

A new helper `typeRepresentationContainsRawPtr(type)` walks the type's
internal representation and returns `true` iff any leaf is a raw
pointer:

| Type tag      | Recurse into                                             |
| ------------- | -------------------------------------------------------- |
| `Ptr`         | **yes — base case, return true**                         |
| `Slice`       | **yes — base case, return true** (carries `*(T)` inside) |
| `Struct`      | every field's type                                       |
| `Enum`        | every variant's fields' types                            |
| `Union`       | every field's type                                       |
| `Tuple`       | every field's type                                       |
| `Array(T, N)` | `T`                                                      |
| `Newtype`     | the underlying type (so `str` recurses to `Slice(u8)`)   |
| `Function`    | NO — function pointers don't dangle through the call ABI |
| `SomeType`    | the resolved concrete type if resolved; otherwise false  |
| primitives    | false                                                    |

Critically, `Slice` is treated as a leaf "yes" — we don't recurse into
its `childType`. The reason: a `Slice` value at runtime IS a fat
pointer; the user-visible type elides the pointer field but the
representation has one.

`ArrayList(T)`, `HashMap(K, V)`, and other heap-owning collections are
NOT counted as transitively-pointer-carrying — they are `object` types
whose underlying memory is heap-allocated and managed by the type
itself (drop runs on the heap pointer, not on a slice into someone
else's storage). The check distinguishes `object`/`atomic(object(...))`
wrappers (heap-owning, safe to return) from plain `struct` wrappers
around `Slice` (borrowing, must flow). The `isStructType(type)` guard
checks `isObjectType(type)` first and returns false.

### Where the check fires

Two enforcement sites:

1. **Function-return site.** In `evaluateAnonymousFunction` and
   `evaluateFunctionType` (the two paths that evaluate function bodies),
   after determining the function's declared return type:

   - If `functionType.return.isRef` is true: existing `ref(T)`
     flowability check applies (unchanged).
   - **NEW:** Else if `typeRepresentationContainsRawPtr(functionType.return.type)`
     is true: apply the same R1–R4 flowability check to the body's
     return expression(s). Reject with a diagnostic naming the type
     and pointing at the offending sub-expression.

2. **`return(...)` statement.** In `evaluateReturnCall`, when the
   enclosing function's return type matches the check above, validate
   the returned expression.

Each enforcement site only fires inside **safe code** (no
`pragma(Pragma.AllowUnsafe)`). Privileged code keeps the existing
behavior — stdlib needs to construct slices from owned heap buffers
that callers will hold onto, and the audit story owns that.

### What the diagnostic looks like

```
error: A function returning `Slice(i32)` (which carries a raw pointer
in its representation) cannot construct it from non-flowable storage.
The returned slice would point into this function's call frame, which
dies when the function returns.

Use one of:
  - Return an owned `ArrayList(i32)` (heap-allocated, no lifetime concern).
  - Take the source as a `ref(name) : ArrayList(T)` parameter and
    project a slice from it.
  - Wrap the slice construction in `pragma(Pragma.AllowUnsafe);` if
    you genuinely need this raw form.

  -> at make_dangling, line 2, expression `arr.as_slice()`
```

### Worked verdicts

```rust
// (1) Local array → slice → return. REJECT.
make_dangling :: (fn() -> Slice(i32))({
  arr := Array(i32, 3).of(i32(1), i32(2), i32(3));
  arr.as_slice()        // arr is a local, non-flowable → reject
});

// (2) Caller's array → slice. ACCEPT (caller owns storage).
borrow_slice :: (fn(ref(arr) : ArrayList(i32)) -> Slice(i32))({
  arr.as_slice()        // arr is ref-bound, R1 flowable → accept
});

// (3) Range slicing on local. REJECT.
sub :: (fn() -> Slice(i32))({
  arr := Array(i32, 5).of(i32(1), i32(2), i32(3), i32(4), i32(5));
  arr(usize(0) .. usize(3))   // local arr → reject
});

// (4) Range slicing on caller's storage. ACCEPT.
sub :: (fn(ref(arr) : ArrayList(i32), n : usize) -> Slice(i32))({
  arr(usize(0) .. n)    // arr ref-bound → accept
});

// (5) String literal return. ACCEPT (static storage).
greet :: (fn() -> str)("hello");  // literal — handled by literal-source check (below)

// (6) String literal indirectly through a binding. ACCEPT.
greet :: (fn() -> str)({
  s := "hello";
  s                     // s holds a str; the source is a literal
});                     // → accept via the "comptime / literal source" carve-out

// (7) Struct wrapping a slice from a local. REJECT.
make_wrapper :: (fn() -> SliceWrapper)({
  arr := Array(i32, 3).of(i32(1), i32(2), i32(3));
  SliceWrapper(s : arr.as_slice())   // wrapper carries Slice → reject
});

// (8) Slice from a local but consumed before return. ACCEPT trivially —
//     the returned expression doesn't construct a slice.
make_len :: (fn() -> usize)({
  arr := Array(i32, 3).of(i32(1), i32(2), i32(3));
  arr.as_slice().len()  // result is usize, no Slice in return type
});

// (9) Pass-through. ACCEPT.
forward :: (fn(s : Slice(i32)) -> Slice(i32))(s);  // s is a parameter (value-typed Slice)
                                                   // → accept via "parameter source" rule
```

The "comptime / literal source" and "parameter source" carve-outs
extend R1 slightly: a name reference is flowable iff:

- the binding has `isRef: true` (current R1), OR
- the binding's value comes from a `comptime` constant / literal
  (representation lives in static storage), OR
- the binding is itself a parameter of the function (caller's
  storage is alive across the call).

The parameter-source rule is sound for non-`ref` parameters too because
the caller's value is alive at least for the duration of the call.
Returning a value-typed `Slice(T)` parameter back to the caller hands
back what the caller already owned.

### Why this works structurally

By induction on the flowability chain:

- Every accepted return value's source is either:
  - A `ref`-bound binding (caller's storage), OR
  - A non-`ref` parameter (caller's storage during the call), OR
  - A comptime/literal value (static storage), OR
  - An `unsafe(...)` block in a privileged file (audit owns it)
- The chain only navigates through fields, projection calls, and slice
  constructors that stay rooted in one of those sources.
- Therefore the returned `Slice(T)` points at storage that's alive at
  least as long as the call that produced it.

This is a strictly weaker guarantee than Rust's lifetime system — a
caller that drops the source after the call returns can still
invalidate the slice. That's the same audit hole as the rest of
`plans/MEMORY_SAFETY.md` Known Limitation #1.

## Phases

### Phase A — `typeRepresentationContainsRawPtr` helper

- Add to `src/types/utils.ts` alongside `typeContainsSomeType` and
  `typeIsControlBound`. Mirrors their recursion structure but with
  `Slice` and `Ptr` as the "yes" leaves and `object`/heap-owning
  structures excluded.
- Unit tests in `src/tests/type-representation-pointer.test.ts`:
  primitives (false), `Slice(u8)` (true), `str` (true via newtype),
  `Array(i32, 3)` (false — array is value-typed, no internal ptr in
  user-visible representation), `ArrayList(i32)` (false — object),
  `struct(s : Slice(u8))` (true), `enum(A(s : Slice(u8)), B)` (true),
  `struct(x : i32)` (false), `Option(Slice(u8))` (true).

### Phase B — Extend R1 with parameter-source and comptime-source rules

- `src/evaluator/types/flowability.ts`: `isFlowableExpr` accepts an
  atom name reference as flowable if its binding is a parameter (any
  parameter, not just `ref`-bound) **when the enforcement-site option
  enables it** (the slice-flowability check passes a new option
  `allowParameterSource: true`; the existing `ref(T)` return check
  does not — that one keeps strict R1 because returning a non-`ref`
  parameter as a `ref(T)` borrow is meaningless).
- Same for comptime-bound names (`isCompileTimeOnly: true`).
- The existing `allowSameFrameLocal` option from Phase D unblock stays
  as-is; the new option is additive.

### Phase C — Enforcement at function-return sites

- `src/evaluator/values/anonymous-function.ts` and
  `src/evaluator/calls/function-type.ts`: after the existing
  `functionType.return.isRef` flowability check, add:
  ```typescript
  if (
    !functionType.return.isRef &&
    typeRepresentationContainsRawPtr(functionType.return.type) &&
    !isUnsafeCapableFile(modulePath)
  ) {
    if (!isFlowableExpr(returnExpr, { allowParameterSource: true })) {
      throw formatErrorMessage({ ... });
    }
  }
  ```
- The unsafe-file gate is consulted via the existing
  `isImplicitlyUnsafeCapableFile` from `src/evaluator/memory-safety.ts`
  (same one used by Phase C structural gates). Privileged code is
  exempt — stdlib needs to construct slices from owned heap buffers.

### Phase D — Enforcement at `return(...)`

- `src/evaluator/builtins/return.ts` (or wherever `evaluateReturnCall`
  lives — find via grep): same check applied to the argument.

### Phase E — Tests + std/ migration audit

- `tests/slice_flowability.test.yo`: each verdict from the "Worked
  verdicts" section as `comptime_expect_error` (negatives) and
  positive runtime tests. Plus the `str` newtype case.
- Audit existing `tests/` and `std/` for accidental violations. If
  any safe-file code path is rejected, decide between:
  - The code is genuinely dangerous → flag, document.
  - The code is safe by design but the rule is too strict → carve-out
    or refine the predicate.
- The `public-safe-report` lint (`src/public-safe-report.ts`) does
  NOT change — it already catches `*(T)` directly in public signatures.
  This is a separate plane: representation-level escape, not signature
  escape.

### Phase F — Docs

- Update `plans/MEMORY_SAFETY.md` Known Limitation #1: mark as
  RESOLVED with a pointer to this doc.
- Update `plans/ITERATOR_REDESIGN.md` Open Question 7: same.
- Update `docs/{en-US,zh-CN}/DESIGN.md` if there's a "Slice" section
  that explains the safety contract.
- `.github/instructions/yo-design.instructions.md`: brief note on the
  rule for future-Claude consistency.

## Open Questions

1. **Does the rule fire on `(fn() -> Slice(T))(some_static_const)`?**
   Currently no, because `some_static_const`'s binding doesn't have a
   special flag. We could carve out "module-level / `::` binding =
   static storage = flowable", but most actual user code that needs
   this writes a literal directly. Defer until a real use case demands
   it.

2. **`Option(Slice(T))` and `Result(Slice(T), E)` returns.** These
   should be caught — the type's representation contains a Slice in
   one variant. The predicate already recurses into enums. The
   evaluator's check should fire on these too. Verify in tests.

3. **What about `comptime` Slices?** A `comptime(s : Slice(u8))` lives
   in compile-time memory; the runtime never holds the pointer. The
   check should only fire on runtime returns. The
   `isCompileTimeOnly`-on-the-return-slot check handles this — comptime
   returns are erased at codegen, no dangling pointer at runtime.

4. **Future user types wrapping Slice.** Anyone can write
   `MySlice :: struct(s : Slice(u8))` in safe code today; the rule
   automatically extends to them. No special-casing needed.

5. **Migration cost.** Best estimate: 0–5 stdlib files contain
   `(fn() -> Slice(T))` returns that don't take the source as a
   `ref(...)` parameter. The fix is either to migrate the parameter
   to `ref(...)` (cleanest) or wrap the unsafe construction in
   `unsafe(...)` (already privileged). Audit during Phase E.

## References

- `plans/MEMORY_SAFETY.md` Known Limitation #1 — the gap this closes.
- `plans/ITERATOR_REDESIGN.md` §"Soundness of `ref(T)` return slots" —
  the structural rule we extend.
- `src/evaluator/types/flowability.ts` — the existing implementation.
