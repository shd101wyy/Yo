# A capture in a generic `io.async` body is retained with another instantiation's type

**Severity:** S2 — a generic method whose `io.async` body owns an `Rc`-holding capture, called at two types, fails in the C compiler (`initializing 'X' with an expression of incompatible type 'Y'`)

**Status:** FIXED 2026-10-14 (feat/vbd-v3-async-a5; found while making the `Stream` consumers own their stream, §3.13 A5).

## Symptom

`Stream.collect` became `collect(self : Self, io)` with the body
`io.async({ self }(io : Io) => …)` in the blanket `impl(generic(S), where(S <:
Stream), S, …)`. Two chains of different shapes over a source that holds an
`Rc` (the async `Channel`, or any `struct(_n : Rc(i32))`), collected in one
binary, failed to compile their C:

```text
error: initializing '__yo_t_14764977298908680982' with an expression of incompatible type '__yo_t_5873659347161426210'
  __yo_t_14764977298908680982 temp_dup_struct_0 = __yo_cap_impl_where_d6_r101c6_n0.__yo_v_self;
error: assigning to '__yo_t_5873659347161426210' from incompatible type '__yo_t_14764977298908680982'
  __yo_cap_impl_where_d6_r101c6_n0.__yo_v_self = temp_dup_struct_0;
```

Reproducer (on develop before the fix, with the A5 `Stream`):

```yo
Src :: struct(_n : Rc(i32));
// impl(Src, Stream(Item : i32, next : …)), counting `_n` down
main :: (fn(io : Io) -> unit)({
  a := io.await(Src(_n : rc(i32(4))).map(x => (x * i32(10))).map(x => (x + i32(1))).collect(io), io);
  b := io.await(Src(_n : rc(i32(4))).filter(x => (x > i32(1))).filter(x => (x < i32(4))).collect(io), io);
});
```

## Cause

`_build_async_capture_struct_literal` (`src/codegen/exprs/async.yo`) builds
the capture struct of an `io.async` body. When the capture struct has no
`___dup` helper, it materializes the literal into a temp and retains each
RC-bearing field with `_rc_field_retain_line`, which declares its temps with
the field's type. It read the fields from the registry,
`get_struct_fields(struct_id)`. A closure in a generic body shares one capture
struct id across its instantiations, so the registry holds whichever
instantiation registered first: the retain temps were declared with another
chain's types. This is the construction-side twin of
`issues/fixed/a-capture-in-a-generic-io-async-body-is-dropped-with-another-instantiations-type.md`,
which fixed the dispose side.

## Fix

The literal builder reads the fields through `_capture_struct_fields`, which
takes each field's type from the instantiated capture type (the dispose side's
fix), instead of from the registry.

Regression test: `tests/async/combinators.test.yo`, "Test collect over chains
of different shapes whose source holds an Rc" (fails the C compile before the
fix).
