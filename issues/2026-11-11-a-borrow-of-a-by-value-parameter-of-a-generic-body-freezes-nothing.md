# A borrow of a by-value parameter of a generic body freezes nothing

**Severity:** S1. In `run :: (fn(generic(T : Type), t : T, where(T <: Get)) -> unit)({ r := t.get(); consume_t(t); println(r.*) })`
the borrow `r` does not freeze `t`: `consume_t(t)` moves and drops it and `r` is read after (ASan:
heap-use-after-free). The same body with a concrete `w : W` parameter, or with `t` first moved into a local, is
E0911. Not async-specific; the future form fails the same way. Pre-existing: v0.2.76 accepts it too.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A52). Confirmed on develop `64f33c710`. Related:
#1875 (`issues/fixed/2026-11-08-a-by-value-fn-parameter-in-a-generic-body-is-reported-as-a-read-only-borrow.md`)
fixed the same flag for the call-site marker rule.

## Reproducers

`issues/repros/2026-11-11-a-borrow-of-a-by-value-parameter-of-a-generic-body-freezes-nothing.yo`
(negative, expects E0911):

```yo
Get :: trait(get : (fn(self : &Self) -> &String));
W :: struct(s : String);
impl(W, Get(get : (fn(self : &Self) -> &String)(&self.s)));
consume_t :: (fn(generic(T : Type), v : T) -> unit)(());
run :: (fn(generic(T : Type), t : T, where(T <: Get)) -> unit)({
  r := t.get();
  consume_t(t);
  println(`OUT: ${r.*}`);
});
main :: (fn() -> unit)({
  run(W(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz")));
});
```

```text
$ yo check repro.yo        # develop 64f33c710 and v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-lend.yo` (negative, E0911): no method call, `r := &t; consume_t(t); r.get()`: heap-use-after-free.
- `…-async.yo` (negative, E0911): `f := t.show(io); consume_t(t); io.await(f, io)` with a trait method returning a
  borrowing future: heap-use-after-free.
- `…-pos.yo` (positive control): `r`'s last use is before `consume_t(t)`.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| generic body, `r := t.get()` then `consume_t(t)` then `r` read | accepted, heap-use-after-free | E0911 |
| the explicit form `r := T.get(&t)` (probe `n05b`) | accepted, heap-use-after-free (ledger) | E0911 |
| generic body, `r := &t` then `consume_t(t)` then `r` read | accepted, heap-use-after-free | E0911 |
| generic body, trait-method future over `t`, `t` moved before the await | accepted, heap-use-after-free | E0911 |
| generic body, `x := t; r := x.get(); consume_t(x)` (probe `n05e`) / `x = u` (probe `n05c`) | E0911 | E0911 |
| non-generic `run(w : W)`, `r := w.get(); consume_t(w)` (probe `n05f`) | E0911 | E0911 |
| caller-side local `w`, `r := w.get(); consume_t(w)` (probe `n05d`) | E0911 | E0911 |

The ledger also lists probe `n02m` here: `fwd(generic(T : Type), t : &T, io : Io, where(T <: Show))` returning
`t.show(io)`; the caller's `w` is not frozen by `f := fwd(&w, io)` (accepted, heap-use-after-free). That
parameter is a reference, not a by-value one, so its cause may differ (forwarding a trait method's future through a
generic bound); it is recorded here as a neighbour, not as the same root.

## Root cause

The binder, verified in the source. A generic body is specialized at call time:
`create_specialized_function_inline` (`src/evaluator/calls/helper.yo`) re-binds each runtime parameter with
`bind_parameter(callee_env, &p_label, ty, value, false, decl_param_is_ref, false, …)` — `is_owning` is `false` for
every parameter. `bind_parameter` (`src/env.yo`) then marks the binding `is_imm_borrow` ("an `x : &T` parameter …
is marked a borrow"), and `_mark_value_rebind` adds `is_value_rebind` for a by-value slot. The definition-time
binder, `_build_def_time_body_env` (`src/evaluator/calls/function_type.yo`), passes `p_own = t_slot_is_by_value(…)`
instead — the mismatch AGENTS.md warns about ("a new binding site must mirror the def-time binder's `own` flags").

#1875 taught two readers to see through the flag (`_marker_place_of` in `helper.yo`,
`shared_borrow_param_root_of_place` in `src/evaluator/exprs/assignment.yo`), and `variable_is_reference_binding` /
`_variable_reference_shape` check `is_value_rebind` too. The borrow tracker's readers do not: for example
`variable_is_borrow_parameter` (`src/evaluator/utils.yo`) is `v.is_imm_borrow() || …`, so `t` reads as a `&T`
parameter, whose place is the caller's and is never frozen inside the body. Which reader drops the loan for
`r := &t` is a hypothesis (`YO_DEBUG_N2B` prints `r`'s live range, `range_of r`, and nothing at
`consume_t(t)`); the binder flags are the verified part.

## Expected

E0911 at `consume_t(t)`: "Cannot move `t` here: `r` borrows `t` with `&` and is still live", as for the concrete
`run(w : W)`. A by-value parameter is a place the body owns (`plans/VALUES_BY_DEFAULT.md` decision 30), and
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` O-1's R-LEND roots `&t` at that place; nothing in either rule
depends on whether `T` is a type parameter. Two fixes fit: mirror the definition-time binder's `own` flag at the
re-bind (the pitfall's advice; the re-bind is non-owning on purpose today, so drop accounting must be checked), or
make every borrow-tracker reader honour `is_value_rebind`, as #1875 did for two of them.

## Test

With the fix: the three negatives and the positive control move to `tests/origins/unsound/`; a case beside #1875's
in `tests/parameter_modes.test.yo`; corpus row `generic-by-value-param-borrowed-then-moved` (E0911).
