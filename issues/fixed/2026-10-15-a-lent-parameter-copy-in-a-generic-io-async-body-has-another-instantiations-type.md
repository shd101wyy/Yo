# A lent-parameter copy in a generic `io.async` body has another instantiation's type

**Severity:** S2 — a generic function whose `io.async` body borrows a `&T` parameter (`{ &body }`), called at two types in one binary, fails in the C compiler (`assigning to 'X' from incompatible type 'Y'`).

**Status:** FIXED 2026-10-15 (`feat/vbd-async-mutex-rust`; found when the
async `Mutex.with_lock` started borrowing its `body` closure through its
capture list).

## Symptom

```yo
apply_later :: (fn(generic(R : Type), body : &Impl(Fn(x : i64) -> R), io : Io) -> Impl(Future(R, Io)))(
  io.async({ &body }(io : Io) => {
    io.await(yield(io), io);
    body(i64(20))
  })
);
main :: (fn(io : Io) -> unit)({
  k := i64(22);
  s := ArrayList(i64).new();
  s.push(i64(1));
  n := io.await(apply_later({ k }(x : i64) => (x + k), io), io);
  m := io.await(apply_later({ &s }(x : i64) => (x * i64(s.len())), io), io);
});
```

```text
error: assigning to '__yo_t_10061771853889782704' (aka 'struct …') from incompatible type '__yo_t_11042919581909675436' (aka 'struct …')
  sm->__yo_lent___yo_v_body = *(sm->__capture.__yo_v_body);
error: incompatible pointer types assigning to '__yo_t_11042919581909675436 *' from '__yo_t_10061771853889782704 *'
  sm->__capture.__yo_v_body = &sm->__yo_lent___yo_v_body;
```

## Cause

A future keeps its own copy of a `&T` parameter it borrows (§3.13 A2): the
state machine gets a `__yo_lent_<label>` slot, and the install copies the
parameter into it. `_lent_param_capture_fields` (`src/codegen/exprs/async.yo`)
read the capture struct's fields from the registry,
`get_struct_fields(struct_id)`. A closure in a generic body shares one capture
struct id across its instantiations, so the registry holds whichever
instantiation registered first, and the slot was declared with that one's
pointee. The third twin of
`issues/fixed/2026-10-14-a-capture-in-a-generic-io-async-body-is-retained-with-another-instantiations-type.md`
and `issues/fixed/a-capture-in-a-generic-io-async-body-is-dropped-with-another-instantiations-type.md`.

## Fix

`_lent_param_capture_fields` reads the fields through `_capture_struct_fields`,
which takes each field's type from the instantiated capture type.

Regression tests: `tests/async/combinators.test.yo`, "Test a lent closure
parameter of a generic io.async body, at two closure types" (fails the C
compile before the fix), and `tests/async_mutex.test.yo`'s two-`R`
`with_lock` test over the new `Mutex`.
