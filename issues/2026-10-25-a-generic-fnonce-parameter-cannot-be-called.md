# A generic `FnOnce` parameter cannot be called

**Severity:** S2 — an `Impl(FnOnce(...))` parameter of a function whose type mentions its own type parameter is rejected at its only call (E0901), so no generic Yo-source API can take a consuming callback; only externs (`io.async`, whose body is never evaluated) and non-generic functions work.

**Found:** 2026-10-25, implementing B7c (`HashMap.entry`, decision 22 — the with-shape prescribes `Impl(FnOnce(e : &mut HashMapEntry(K, V)) -> R)) -> R`, and `R` makes every call generic).

## Symptom

```yo
take_once :: (fn(generic(U : Type), sink(f) : Impl(FnOnce() -> U)) -> U)(f());
take_once(() => i32(1));
```

```text
error[E0901]: use of moved value: cannot call `f`: an `FnOnce(...)` call consumes the
closure, and `f` cannot give it away: it is a borrowed parameter, and a borrow cannot
give the closure away: take the parameter by value, `sink(f) : Impl(FnOnce(...))`
(only an API the closure escapes into calls it once).
  --> ./tmp/probe9.yo:2:74
   |
 2 | take_once :: (fn(generic(U : Type), sink(f) : Impl(FnOnce() -> U)) -> U)(f());
   |                                                                          ^
help: call an `Fn(...)` closure through a borrow; an `FnOnce(...)` closure is called
      once, by its owner

note: in `take_once` with U = i32, instantiated here
```

The `Fn` twin of the same function passes — that is the exact shape #1428 fixed
(`issues/fixed/2026-10-15-the-generic-call-time-binder-binds-a-sink-closure-argument-at-a-bitwise-fn-type.md`):

```yo
take_fn :: (fn(generic(U : Type), sink(f) : Impl(Fn() -> U)) -> U)(f());  // checks
```

Both spellings fail the same way — `sink(f)` and a plain by-value `f` — and so
does a `generic(R : Type)` method parameter. The non-generic twin
(`fn(sink(f) : Impl(FnOnce() -> i32)) -> i32`) passes.

## Root cause (as far as probed)

The #1428 fix names the argument's capture struct as the type that decides who
owns a deferred closure literal (`_fv_closure_argument_owned_type`,
`src/evaluator/calls/function.yo`), so the caller transfers the closure and the
callee binds the parameter owning. The `FnOnce` CALL check
(`consume_called_fnonce_closure`, `src/evaluator/utils.yo`) then reads the
binding of the name and accepts only an owning one — or a non-owning parameter
shadow with an OWNING binding of the same name beside it in the same frame
(`_owning_param_binding_beside`). For the `FnOnce` parameter of a specialized
generic body that owning binding is missing, so the check rejects the one call
the parameter exists for. The #1428 transfer/binding fix demonstrably covers
`Fn` and not `FnOnce`; whether the move is never recorded or the beside-binding
is not pushed at the `FnOnce` call site was not root-caused further (it needs
`eprintln` tracing of a tree-built binary, the method the 2026-10-15 doc used).

## Consequence

- Decision 22's `entry` with-shape is specified with an `FnOnce` body
  (`plans/handover/VBD_LOOKAHEAD_2026-10-23.md` §4.3). B7c lands it with the
  borrowed `&Impl(Fn(...))` body every other std with-shape uses
  (`ArrayList.with`, `Deque.with`, `RefCell.with_mut`); the flip to `FnOnce`
  — which lets a body move its own captures into the map — waits on this fix.
- Any generic API that wants a consuming callback (a task runner, a
  `replace_with`-style taker) cannot be written in Yo source today.

## Proposed fix

Mirror the #1428 fix through the `FnOnce` consumption path: when the argument
of a by-value `Impl(FnOnce(...))` parameter is a deferred closure literal, the
caller-side move (`fv_closure_moved_args`) and the bind-side beside-binding
must line up so `consume_called_fnonce_closure` finds an owning binding, and
the def-time trial binder must bind the parameter owning (as
`_build_def_time_body_env` does for `own` flags) so a trial does not reject
first. Gate: `check ./src`, `check ./std`, `tests/closure_param_forwarding.test.yo`
(extend with the `FnOnce` relay), `tests/closures.test.yo`,
`tests/thread.test.yo` (the `sink(cb) : Impl(FnOnce(...))` spawn path), plus an
emit-diff of a generic `FnOnce` call (only the release may move sides, as in
#1428).
