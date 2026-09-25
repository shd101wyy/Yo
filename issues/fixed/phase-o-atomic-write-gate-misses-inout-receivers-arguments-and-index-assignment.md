# The Phase O "no writes through an atomic object" gate misses `inout(self)` receivers, `inout` arguments and index assignment

**Found:** 2026-09-25, parallelism-soundness audit (`plans/PARALLELISM_SOUNDNESS.md`, finding P-1).
**Status:** FIXED 2026-09-26 (`plans/PARALLELISM_SOUNDNESS.md` Phase 1, rule D3 of `plans/reference/PARALLELISM_RULES.md`). Was: **Data race in safe code.** `docs/en-US/THREAD_SAFETY.md` §"Atomic Field
Mutation is Forbidden in Safe Code" says the write is a compile-time error; three spellings of it
compile and write through the shared object.
**Measured:** yo 0.2.41 seed against the develop tree's `std` (`--std-path`), macOS arm64.

## Repro

`issues/repros/phase-o-inout-receiver-writes-through-arc.yo`:

```rust
{ println } :: import("std/fmt");
Counter :: struct(n : i32);
impl(
  Counter,
  bump : (fn(inout(self) : Self) -> unit)({
    self.n = (self.n + i32(1));
  })
);
bump2 :: (fn(inout(c) : Counter) -> unit)({
  c.n = (c.n + i32(10));
});
main :: (fn() -> unit)({
  a := arc(Counter(n : i32(0)));
  a.*.bump();
  bump2(a.*);
  println(`n=${a.*.n}`);
});
export(main);
```

`yo check` is green, `yo compile --optimize 2` is green, the binary prints `n=11`: both the
method receiver and the free-function argument wrote INTO the `Arc`'s storage. The direct
spelling `a.*.n = i32(1)` is rejected as documented.

`issues/repros/phase-o-index-assignment-writes-through-arc.yo` is the third spelling:

```rust
a := arc(Array(i32, usize(2))(i32(0), i32(0)));
a.*(usize(0)) = i32(7);        // green; prints v=7
```

Put `a` in a `Thread(unit).spawn` closure (an `Arc(Counter)` is `Send`) and call `a.*.bump()`
from both threads: two unsynchronized read-modify-writes of the same `i32`, in a file with no
pragma.

## Mechanism (READ)

`get_atomic_object_root_type` (`src/evaluator/exprs/assignment.yo` ~250) is called from ONE
place: the property-assignment arm of `evaluate_assignment` (~380). It is not called from

- the index-assignment arm of the same function (`arr(0) = rhs`), and
- any call site. `plans/archive/THREAD_SAFETY.md` vector 26 ("Passing an atomic-object field as
  `ref(T)` / `inout` to a function") is marked closed by Phase O, but no call-site rule exists:
  `grep -rn get_atomic_object_root_type src/evaluator` finds only the assignment file.

`inout(self)` method receivers and `inout(x)` parameters are exactly the "callee writes through
it" shape vector 26 describes, and an `inout` receiver on a value-struct method is the idiomatic
way to mutate a value struct, so this is the COMMON spelling, not a corner.

## Fix direction

One predicate, `expr_roots_in_atomic_object(expr, env)` (a field/index/deref chain whose root
binding is an atomic object — the existing helper generalized from "atom" to "chain"), applied at
three sites in safe code:

1. property assignment (today),
2. index assignment (`evaluate_assignment`'s index arm),
3. every argument bound to an `inout(...)` parameter, including the implicit `self` of a method
   call (`src/evaluator/calls/`: where `inout` arguments are validated for exclusivity is the
   right hook — the peer plan's Phase 5.2 touches the same site).

`Mutex.with_lock`'s `inout(v)` stays legal: `v` is a parameter binding, not an atomic-object root
(the primitive vouches for it). Diagnostic: the existing E-code and message from site 1. Tests:
`tests/thread_safety.test.yo` gets three `comptime_expect_error` blocks (receiver, argument,
index) plus an over-rejection canary (`with_lock` body mutating `v.n`, an `inout` call on a
LOCAL copy `c := a.*; c.bump()`).

## Fix (2026-09-26)

One predicate, `throw_if_write_through_atomic_root(place, env, how, exn)` in
`src/evaluator/exprs/assignment.yo`, built on a new `get_root_expr_of_place` that walks `.`
chains AND index calls (`a.*(0)` is a call whose callee is the place), applied at three sites in
files without the pragma:

1. the property/index arm of `evaluate_assignment` (replacing the field-only walk);
2. `check_if_function_parameter_matches_argument` (`src/evaluator/calls/helper.yo`), right
   before its Step 4c, for every `inout` parameter — the method receiver arrives here as the
   `self` argument, so `a.*.bump()` is caught with the message "Cannot call an inout(self)
   method on atomic object 'a'";
3. the inline `FuncVal` argument loop in `src/evaluator/calls/function.yo`, which bypasses (2).

Both hooks skip the CHECKING PHASE (trial calls), like Steps 4b/4c; the real pass throws.
`Mutex.with_lock`'s `inout(v)` is a parameter root, so the body still writes; a local copy
`c := a.*` is a value. Tests: `tests/parallelism_soundness.test.yo` — four `comptime_expect_error`
blocks (receiver, argument, index, a user atomic object) and two canaries (the same three
shapes on a plain `ref` struct; the copy). All three repros are rejected by the tree-built
compiler; the seed cannot see the gate (`issues/fixed/…` memory: fresh-binary check gate).
