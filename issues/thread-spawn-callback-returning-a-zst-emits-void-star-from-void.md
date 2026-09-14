# `Thread(T).spawn` cannot take a callback returning a ZST — the spawn path emits `void* tmp = <void expr>`

**Status:** BOTH symptoms are **FIXED** (2026-09-12). D18 part 2 is still
**BLOCKED**, on the `Send` capture judgement alone — see the correction below. The workaround
recorded below dodges this bug and then hits that wall — see "Why the
workaround does not land either".

> **CORRECTION 2026-09-12 — "specific to the thread-spawn lowering" was
> wrong.** The three controls below are not enough to narrow it there.
> `issues/repros/closure-call-void-result.yo` reproduces symptom 1 with **no
> thread, no spawn, no channel**: a plain closure that captures an
> `Impl(Fn(n : i32) -> T)` parameter and binds its call at `T = unit`. The
> lowering in `src/codegen/exprs/parallelism.yo` is NOT involved.
>
> The real cause was the `cc_` static-dispatch call site in
> `other_fn_call.yo` (and the binding emitter one level up in
> `init_assignment.yo`) reading the CALL EXPRESSION's type — still the
> unresolved `T`, spelled as the erasure `void*` — instead of the callee's own
> emitted prototype, which says `void`. All three emitters ask the callee now.
> See `issues/fixed/closure-call-binds-a-void-result-to-a-void-pointer-temp.md`
> for the mechanism, the measurements, and the red-first test.
>
> Symptom 2 — the `Channel(unit).send` specialisation called and never emitted
> — is also NOT the spawn lowering, and is also FIXED. The specialisation binder
> bound the `Impl(Fn(...))` parameter VALUELESS, so the body's `cb(io)` kept the
> enclosing generic's binder as its result type; the `send` it feeds keyed its
> specialisation on that abstract type, and the key named the def-era ORIGINAL,
> which the emission loop deliberately skips. See
> `issues/fixed/generic-channel-send-specialisation-is-called-but-never-emitted.md`
> (an early reading of it as "two manglings of one specialisation" was a
> symptom, not the cause).
>
> **The D18b repro now compiles and RUNS.** What remains for D18 part 2 is only
> the `Send` capture judgement.

Found 2026-09-07 attempting **D18 part 2**
(`plans/STD_API_STABILIZATION.md` §2: *"`Thread(T).spawn` carries its result and
`join() -> T`"*).

## What fails

Making `Thread` generic over its result — the D18 design — means `spawn` takes
`cb : Impl(Fn(io : Io) -> T, Send)` and the thread body does the send:

```rust
spawn : (fn(cb : Impl(Fn(io : Io) -> T, Send)) -> Self)({
  chan := Channel(T).new(usize(1));
  sink := chan;
  raw := __yo_thread_spawn((io : Io) => {
    sink.send(cb(io));
    ()
  });
  Self(handle : raw, _joined : false, _result : chan)
}),
```

At `T = unit` — which is what EVERY existing `Thread.spawn` call site becomes —
the emitted C does not compile:

```
error: initializing 'void *' with an expression of incompatible type 'void'
 3640 |   void* _file____priv_temp_13182 = closure_yo_id_11371(&(((__yo_t34*)closure_context)->cb), io);

warning: call to undeclared function 'yo_id_11019_..._ret_enum_..._value_unit_error_...'
error: initializing '__yo_t23' with an expression of incompatible type 'int'
 3644 |   __yo_t23 _file____priv_temp_13268 = yo_id_11019_...(((__yo_t34*)closure_context)->sink, _file____priv_temp_13182);
```

Two symptoms: the captured callback's `unit` result is bound to a `void*` temp,
and the `Channel(unit).send` specialisation is never emitted (implicit
declaration).

Writing `sink.send(cb(io))` without the intermediate local does NOT help — the
temp is created either way.

## What NARROWS it to the spawn path

Three controls, all of which compile AND run:

1. **`Channel(unit)` on its own** — `new` / `send` / `try_recv` at `T = unit`.
2. **A generic fn calling a `Impl(Fn() -> T)` parameter at `T = unit`.**
3. **The same closure CAPTURED into a second closure** that is handed to a
   `Fn() -> unit` consumer, sending through a `Channel(T)` — i.e. the exact
   shape above, minus `__yo_thread_spawn`.

So it is neither `unit`-as-a-ZST in general, nor generic closure calls, nor
nested capture. It is specific to the **thread-spawn lowering**.

## Where it lives

`src/codegen/exprs/parallelism.yo` gives spawn callbacks their own
capture-struct lowering, separate from ordinary closures — its own comments say
so:

- line 156: *"selects the primitive + **(unit) return convention**"*
- line 166: *"SPECIALIZED Thread.spawn body — the lowered capture-struct PARAM
  (cei.ty IS the SomeT)"*
- it imports `is_unit_type` from `../../types/guards.yo`

and `_generate_spawn_wrapper` emits a wrapper that is `static void` and
DISCARDS the callback's result:

```c
static void <wrapper>(void* closure) {
  <closure_fn>(closure, <runtime_args>);
}
```

That wrapper shape is correct for the D18 design (the inner closure really does
return `unit`). The failure is one level in: the **captured** `Impl(Fn(io) -> T)`
call inside that lowered body binds its result to a temp without asking whether
`T` is a ZST.

`src/evaluator/calls/function.yo:2285` notes the matching evaluator-side
special case (*"specialized `Thread.spawn -> Self` would never be emitted"*), so
a fix likely has to touch both sides.

## Blast radius if fixed

152 real `Thread.spawn(` call sites (all in `tests/`; `std/` and `src/` only
mention it in comments) become `Thread(unit).spawn(`. Nothing outside tests
calls it.

## The std-side design, ready to go

Recorded so it is not re-derived. `Thread` becomes:

```rust
Thread :: (fn(comptime(T) : Type, where(T <: (Send, Acyclic))) -> comptime(Type))(
  ref(struct(handle : __yo_thread_t, _joined : bool, _result : Channel(T)))
);
```

`join` keeps the join-once assert and the detach-on-drop `Dispose` from
`issues/fixed/thread-join-was-re-callable-and-handles-leaked.md`, then reads the
value:

```rust
join : (fn(self : Self) -> T)({
  assert(!self._joined, "Thread.join: this thread was already joined");
  self._joined = true;
  __yo_thread_join(self.handle);
  match(
    self._result.try_recv(),
    .Some(v) => v,
    .None => __yo_panic("Thread.join: the thread body produced no value (it unwound)")
  )
}),
```

`try_recv` rather than `recv`: the OS join has already returned, so the value is
buffered and a blocking `recv` would only risk hanging when the body unwound
without sending. `unit` is both `Send` and `Acyclic` (`std/prelude.yo:817,820`),
so `Channel(unit)` satisfies the bound.

## The workaround (dodges this bug)

Control #2 above is also the way out. Moving the call-and-send OFF the
spawn-lowered closure body and into an ordinary top-level generic function
keeps it on the normal closure path, which handles the ZST correctly:

```rust
/// Deliberately a top-level generic function rather than inline in the spawn
/// closure — see `Thread(T).spawn`.
_run_and_send :: (
  fn(
    generic(T : Type),
    cb : Impl(Fn(io : Io) -> T),
    sink : Channel(T),
    io : Io,
    where(T <: (Send, Acyclic))
  ) -> unit
)({
  sink.send(cb(io));
});
```

and the spawn closure becomes:

```rust
raw := __yo_thread_spawn((io : Io) => {
  _run_and_send(cb, sink, io);
  ()
});
```

`Thread(unit)` and `Thread(i32)` both compile and run with that shape in
isolation.

## Why the workaround does not land either

The full suite rejects it. `tests/sync/once.test.yo` fails with:

```
error: Captured variable 'cb' (type Impl : (Fn(Io) -> unit + Send)) does not
implement Send. To move it across threads, wrap it in Arc/Iso, or capture a
Send projection of it instead.
```

The helper makes the spawn closure **capture** `cb`, where before the change
`cb` went straight to `__yo_thread_spawn` and was never a captured variable.
#451's Send enforcement (`validate_capture_trait_requirements`,
`src/evaluator/utils/closure.yo:224`) then judges it — and
`_capture_judgement_type` resolves a captured CLOSURE to its own capture
struct. One more level of nesting therefore puts a struct in front of the
checker that carries no `Send` impl, even though every value inside it is
`Send`.

**Adding `Send` to the helper's parameter does NOT fix it** (tried): the
declared type is what the message prints, but the judged type is the resolved
capture struct.

So D18 part 2 needs a compiler change either way:

* fix this bug (the spawn lowering's ZST-returning captured call), which makes
  the INLINE form work and removes the need for the helper; or
* teach `_capture_judgement_type` that a closure whose own captures are all
  `Send` is itself `Send`, which makes the HELPER form work.

The first is the narrower change. The second touches a security-relevant
checker and should not be rushed.
