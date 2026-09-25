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

Two pieces in `src/evaluator/exprs/assignment.yo`, built on a new `get_root_expr_of_place` that
walks `.` chains, index calls (`a.*(0)` is a call whose callee is the place) and `label : place`
wrappers:

1. `throw_if_write_through_atomic_root` — unconditional, for the assignment arm of
   `evaluate_assignment` (field AND index stores are plain writes).
2. `d3_record_inout_place` / `d3_check_pending` — for `inout` bindings. The first attempt threw
   at the binding site for every `inout` parameter and rejected `${a.*.id}` (`ToString` takes
   `inout(self)`), `tx.clone()` on a `Sender` and every read-only `inout(self)` method: `inout` is
   Yo's plain by-reference receiver, not a mutation marker. So the binding is RECORDED at the two
   argument-binding sites (`try_to_call_function_with_arguments`'s parameter loop in
   `calls/helper.yo` and the inline `FuncVal` loop in `calls/function.yo`, which also hands the
   list to `_evaluate_funcval_runtime_call`) and DECIDED after the (specialized) callee is known,
   with the per-parameter mutation mask of `effects/mutation_summary.yo`: reject iff the callee
   may write through that parameter. A callee in a pragma'd file is the audited base and is
   trusted. The mask itself gained `_msp_inout_param_of_place`: a value-field or index store
   through an `inout` parameter, and passing a place rooted in one to a callee that writes through
   its parameter, now set the parameter's shallow bit even when the parameter's type roots no RC
   storage (the aliasing analysis ignored inert types by design). The method receiver arrives as
   the `self` argument, so `a.*.bump()` needs no separate site.

Tests: `tests/parallelism_soundness.test.yo` — four `comptime_expect_error` blocks (receiver,
argument, index, a user atomic object) and three canaries (the same shapes on a plain `ref`
struct; a read-only `inout(self)` method and `ToString` through an `Arc`; the local copy). All
three repros are rejected by the tree-built compiler; the seed cannot see the gate.
