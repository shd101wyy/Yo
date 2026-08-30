# `-> Impl(Future(R))` specializations shared ONE return wrapper — the second `R` miscompiled the first

**Status: caller half FIXED 2026-08-29; BODY HALF FIXED 2026-08-30 (see below).
`Mutex.with_lock` RESTORED with regression tests. The ASan/E variant (second
symptom below) is a DIFFERENT site — spec-cache dispatch — and stays open.** **Found:** 2026-08-29 restoring
`Mutex.with_lock` (`std/async/mutex`) after C27: the test called
`with_lock((v) => (v * i64(2)), io)` and `with_lock((v) => `v=${v}`, io)` on
one mutex and clang rejected the batch:

```
error: initializing '__yo_t10' (aka 'struct __yo_t10_struct') with an expression of incompatible type 'int64_t'
  __yo_t10 temp_dup_enum_yo_id_11266 = __sync_future__file____priv_temp_13096->result;
error: initializing 'int64_t' with an expression of incompatible type '__yo_t9' (aka 'struct __yo_t10_struct')
  int64_t _file____priv_temp_13090 = closure_yo_id_11203(&(sm->__capture.body), (&(sm->__capture.self->_value)));
```

## Body half FIXED (2026-08-30)

The stamping site was NOT the arms first instrumented — it is the `_`-fallback
arm's RUNTIME-CALL tail in `evaluate_function_call` (`ret_type_rt`/`out_rt`,
where an UnknownVal callee — a valueless closure param like `body` — is
stamped; `body`'s capture carries the DECLARED `Impl(Fn(...) -> R)` type).
`ret_type_rt` is now resolved through `_resolve_some_types_deep(_, caller_env)`
before stamping: the enclosing specialization's env binds `R` concretely, so
each spec's own call site stamps its own `R` (`before=R after=String` /
`after=i64` in the trace). Two sibling tails (the method arm's `m_out_ty`, the
`.None` arm's `ret_type_none`) carry the same env-resolving stamp for
consistency — the class fix at every valueless-callee stamp site. Verified:
the repro compiles AND runs (`v=10 11`), tests/future_wrapper_two_r.test.yo
2/2, tests/async_mutex.test.yo 4/4 (with_lock restored with i64+String bodies
on one mutex, both orders).

The ASan/E symptom is NOT fixed by this (the re-emitted batch still shows the
identical `set_effect` 40-from-32 read at index 85): C60 pre-binds `E` from
the receiver correctly at EVAL time, yet the child SM is emitted with an
IoExn bundle the test never mentions — the next session should look at the
SPECIALIZATION-CACHE dispatch (which spec's future constructor the await site
calls), not at E stamping. Repro assets on `debug/asan-batch`.

## Second symptom (2026-08-30): the develop-HEAD ASan red is this same mechanism on the EFFECT type

Every native test leg fails one `tests/async_await.test.yo` test with an ASan
stack-buffer-overflow: a bundle temp sized by one specialization's view of a
future's effect (`Io`, 32 bytes) is copied by a `set_effect` emitted under
another specialization's view (`IoExn`, 40 bytes) — same shared-registry
clobber, `E` instead of `R`. Full analysis + the not-viable codegen mitigation
attempt: issues/asan-stack-overread-set-effect-batch-selftest.md. This makes
the C54 body half the critical path for the v0.2.21 release (develop CI is
red until it lands).

## Reproducer

`issues/repros/future-wrapper-return-two-r-specializations.yo`: a generic impl
method `apply_async_r : (fn(generic(R : Type), self : Self, body : Impl(Fn(inout(v) : T) -> R), io : Io) -> Impl(Future(R)))`
awaited once with a `String`-returning closure and once with an `i64` one.
Either call alone compiles; the pair does not.

## Mechanism

Each specialization DOES get its own async block and sync-future struct
(`…10673_sync_fut_t` with a `String` result, `…10682_sync_fut_t` with
`int64_t`) — the emitted C proved that. What collided was the CALLER: a call
returning a wrapper (`Impl(Future(R))`) stamps its result type with a
resolution cell bridged to the callee's async block by reading
`ExprInfo[callee.body].ty` (`_with_resolved_concrete`, the TS
`finalReturnType = { ...returnType, resolvedConcreteType }` port). That
bridge ran BEFORE the specialization was minted, on the ORIGINAL method
FuncVal — whose body is one shared expression stamped by whichever
specialization was evaluated LAST. Both callers therefore cast the returned
future to the second spec's struct, and the first caller's `->result` read
`int64_t` where the struct held a `String` (and vice versa in the mutex test).

Two earlier hypotheses were wrong and are recorded so they are not retried:
freshening the wrapper's SomeT id when its carriers resolve (in
`_resolve_some_types_deep`, then in `substitute` itself) changed nothing —
`type_key` of a SomeT is its id, but the caller never keyed by it; it went
through the cell.

## Fixed half (2026-08-29): the caller

`src/evaluator/calls/function.yo`, method-dispatch arm: a wrapper return is
bridged with `_with_resolved_concrete` to THIS callee's async block (the
specialization's fresh-id body stamp), exactly as the FuncVal arm always did.
The FuncVal arm re-bridges after the mint too. Both call sites in the repro now
cast to their own specialization's future struct (verified in the emitted C).

## Open half: the specialization's async body

With the caller fixed, three errors remain INSIDE the `R = String`
specialization's async-body closure:

```
int64_t _file____priv_temp_10671 = closure_yo_id_9674(&(...->body), &spill);   // 9674 IS the String closure
int64_t r = _file____priv_temp_10671;
return r;                                   // from a function returning __yo_t3 (String)
```

Each specialization has its own body clone and its own async closure
(`closure_yo_id_9680` vs `_9689`, distinct temps), so the stamps are per
spec — but the `body(self._value)` call's ExprInfo type is the bare forall
SomeT `R`, not `String`. Codegen renders a SomeT through its own cell, then
`lookup_some_resolved_concrete(id)`; the forall `R` SomeT has ONE id across
both specializations, and `_resolve_some_types_deep` registers `R := <env
value>` into that global table whenever it resolves `R` from an env — so the
second specialization's `R := i64` is what the first specialization's body
renders. Next step: stamp the call result CONCRETELY inside the spec body
(resolve `R` through the spec's env at stamping time) or stop keying the
global fallback by the shared forall id.

## Not the cause (recorded so they are not retried)

Freshening the wrapper SomeT's id when its carriers resolve — in
`_resolve_some_types_deep`, then in `substitute` — changed nothing:
`type_key` of a SomeT is its id, but the caller never keyed by it (it went
through the cell), and the body half never involved the wrapper at all.

## Regression test (to add when the body half lands)

`issues/repros/future-wrapper-return-two-r-specializations.yo` as a test, and
`Mutex.with_lock` restored with `i64` and `String` bodies on one mutex.
