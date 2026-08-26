# A unit-resolving tail await emitted `sm->await_result_N;` — a field the state struct never declares

**Status: FIXED 2026-08-26.** Found implementing D5 slice 2
(`plans/STD_API_AUDIT.md` §D5): the very first where-bound generic wrapper over
the new `Writer.write_all` trait default failed to C-compile.

## Symptom

```
/tmp/d5probe.c:13413:11: error: no member named 'await_result_0' in 'struct _file____priv_temp_11298_state_t_struct'
13413 |       sm->await_result_0;
```

Loud (clang error), but the diagnostic names a minted temp and a generated
field — nothing the user wrote.

## Trigger shape

An `io.async` body that IS a tail await of an **effectively-unit** future —
unit, or an **unresolved SomeT** (which is what an `Impl(Future(unit, IoExn))`
return reached through a `where(S <: Trait)` bound looks like at this point):

```rust
put_all_generic :: (
  fn(generic(S : Type), s : S, v : u8, io : Io, where(S <: Sink)) -> Impl(Future(unit, IoExn))
)(
  io.async((e) => e.io.await(s.put_all(v, io), e))
);
```

Reproducer: `issues/repros/unit-tail-await-of-trait-default-reads-missing-await-result.yo`
(rc=1 on the pre-fix compiler with exactly the error above; compiles and runs
rc=0 after). A REAL-unit tail await of a concrete async fn does NOT trigger it
— that shape takes a different path and was already clean, which is why
`io.async((e) => e.io.await(exists(...), e.io))`-style code never hit this.

## Mechanism

Three emitters must agree on when an await's result gets an `await_result_N`
state-struct field, and two of them did:

- **struct allocation** (`src/codegen/exprs/async.yo`): guards on
  `_await_result_is_unit` — real unit OR unresolved SomeT ⇒ NO field;
- **extraction** (`src/codegen/async/state_machine.yo`,
  `_emit_prev_await_result_extraction`): same predicate inlined
  (`is_prev_unit`) ⇒ never writes the field;
- **the completion-segment substitution**
  (`src/codegen/async/state_code_gen.yo`, `generate_state_segment_code`): a
  standalone tail await is moved into the completion segment
  (`split_into_state_segments`'s tail-move) and its await node is registered
  to render as `sm->await_result_N` — **with no unit guard**. The completion
  segment then emits the bare statement `sm->await_result_0;`, reading a
  member the struct never got.

## Fix

`generate_state_segment_code` now skips the substitution registration for an
effectively-unit hoisted await (same predicate as the other two sides).
`generate_await` (codegen/exprs/await.yo) then renders `""` for the node —
its documented in-state-machine fallback — and both emit paths already skip
empty code, so nothing is emitted for the value that does not exist. The
restore step is guarded the same way.

Safe for the other hoisted-await positions: a `cond`/`while` condition is
`bool` and a `match` scrutinee cannot be unit (the evaluator rejects it), so
an effectively-unit hoisted await only ever occurs as a body result.

## Verification

- Red-first reproducer above (pre-fix rc=1, post-fix rc=0 compile AND run).
- Regression test `tests/async_unit_tail_await.test.yo` (the repro shape plus
  a concrete-unit tail-await control).
- D5 slice-2 probe: `read_to_end`/`read_to_string`/`write_all` defaults +
  `io.copy` over `File`, all green.
- Full battery on the branch (suite, cli-diff goldens, gates, fixpoint,
  hollow sweep).
