# `Send` was not enforced at any spawn boundary — `validate_capture_trait_requirements` was a no-op stub

**Status: FIXED** (2026-09-06, `src/evaluator/utils/closure.yo`,
`src/evaluator/calls/closure_type.yo`, `src/evaluator/values/anonymous_function.yo`).
Found by the std API audit — `plans/STD_API_STABILIZATION.md` §3 item 2.

## Symptom

`Thread.spawn` and `spawn(pool, …)` take `Impl(Fn(io : Io) -> unit, Send)`.
The `Send` was decorative: the evaluator function that checks a closure's
captures against the wrapper's non-Fn traits was ported as

```rust
validate_capture_trait_requirements :: (fn(_wrapper_type, _capture_type, _env, _error_token) -> unit)(());
```

and — worse — nothing called even that. A closure capturing a non-atomic
`ref` struct (an `ArrayList`, a `String`, any `ref(struct)`), an `Io` or a
`JoinHandle` crossed an OS thread without a diagnostic; the `Type.impls(…,
Send) == false` assertions in `tests/thread_safety.test.yo` proved the trait
answers were right and nothing consumed them.

## Fix — the faithful port

`validate_capture_trait_requirements` now mirrors the TS
(`src/evaluator/utils/closure.ts:105-175`): for every non-Fn trait in the
wrapper `SomeT`'s `required_trait_types`,

1. each captured variable is checked first (`type_implements_trait_bool`), so
   the error lands on the CAPTURE site —
   `Captured variable 'items' (type ArrayList(i32)) does not implement Send. To
   move it across threads, wrap it in Arc/Iso, or capture a Send projection of
   it instead.`;
2. then the capture struct as a whole, listing the offending fields at the
   closure site.

It is called from both places the TS called it: the `Impl(Fn)`-wrapper route
(`closure_type.yo`, TS `closure-type.ts:269`) and the anonymous-function route
(`anonymous_function.yo`, TS `anonymous-function.ts:1184`), each right after
the capture struct is created.

## A captured closure is judged by ITS captures

The first full-suite run under the check produced exactly one failure:
`tests/sync/once.test.yo` binds `(racer : Impl(Fn() -> unit)) = (() => …)` over
an `OnceCell` and two `AtomicI32`s and spawns `io => racer()` four times. The
captured variable's type is the `Impl(Fn)` wrapper SomeT, which carries no
`Send` in its required traits, so a naive check rejected it. In Rust a closure
is `Send` iff its captures are (an auto trait), and here that is exactly what
the closure's capture struct encodes — `auto_derive_traits_for_struct_type`
gives it `Send` when every field is. `_capture_judgement_type` therefore
resolves a SomeT capture to its concrete type — the SomeT's own resolved cell,
then the global registry, then the captured VALUE's registered capture struct —
and judges that; a closure with no capture struct captures nothing and is
trivially `Send`. With capture info present, the per-variable pass is
authoritative and the aggregate struct check is skipped (the struct's fields
ARE those variables, and re-judging a wrapper SomeT field without its value
would undo the resolution). `once.test.yo` is unchanged and passes;
`thread_safety.test.yo` pins both directions (a closure over an `ArrayList` is
rejected, one over an `AtomicI32` is accepted).

## Known remaining gaps

**Only CAPTURES are checked.** A module-level binding referenced from a spawned
closure is a global, not a capture, so a `ref(struct)` global reached from a
thread is not rejected (the TS check had the same scope). Whether globals may
be touched from spawned closures at all is a separate design question for the
thread-safety model; the regression tests therefore make the offending value
a FUNCTION LOCAL (a `comptime_expect_error` block that defines and calls a fn).


`issues/type-impls-reports-true-for-a-blanket-impl-whose-where-clause-fails.md`:
`Type.impls(*(NonSend), Send)` answers `true` because the prelude's
where-bounded blanket impls are matched without discharging their `where`
clause. Until that is fixed the enforcement UNDER-rejects raw pointers,
`Array(NonSend, N)` and `?(*NonSend)` captures; direct `ref` struct, `Io` and
`JoinHandle` captures are rejected correctly.

## Regression tests

`tests/thread_safety.test.yo`, "Phase L: Send is ENFORCED": two
`comptime_expect_error` blocks (a `ref(struct)` capture and an `ArrayList`
capture in `Thread.spawn`) — both were "Expected compile error, but the
expression was evaluated successfully" on the pre-fix compiler — plus an
over-rejection canary spawning with a scalar and an `Arc` capture.
