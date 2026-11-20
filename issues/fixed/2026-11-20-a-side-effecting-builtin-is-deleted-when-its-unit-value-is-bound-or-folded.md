# A side-effecting builtin is deleted when its unit value is bound or folded

**Severity:** S1 — accepted code silently loses a reference-count change, a `consume`d call or a `consume(p.* = v)` store, which leaks or frees a live object (use after free in the original probe).

- Filed: 2026-11-20 (v0.2.80 bug lane; found by a Fable consultation on the v0.2.70 probes `~/Workspace/Yo-wt/v0273/fable/v70-probes/dce.yo` and `clone_no_dup.yo`).
- Status: FIXED on branch `v0280/extern-dce`.
- Reproducer: `issues/repros/2026-11-20-a-side-effecting-builtin-is-deleted-when-its-unit-value-is-bound-or-folded.yo`.
- Test: `tests/unit-value-side-effects.test.yo`.

## What happens

The consultation reported it as "an `extern("Yo", …)` call bound to a local
disappears":

```yo
extern("Yo", __yo_incr_rc : (fn(cell : *void) -> *void));
keep :: (fn(h : &Rc(i32)) -> unit)({
  cell := unsafe(unsafe.cast(h, *i32));
  _p := __yo_incr_rc((*void)(cell));
  ()
});
```

The emitted `keep` ends after `cell`'s declaration, and `ref_count` stays 1.
The extern declaration is not what matters: `__yo_incr_rc` is a compiler
builtin dispatched by name (`src/evaluator/exprs/dispatch.yo`), so the
declaration is shadowed and its `*void` result type is never used (the call is
typed `unit`; `p := __yo_incr_rc(c); p` in a `-> *void` function is E0604). An
`extern("C", …)` call bound to a local is emitted correctly, and so is a Yo
function bound the same way (`_q := bump(addr_of(n))`).

What the failing forms share is a unit-typed expression whose evaluator
records a known value `()` while it runs something at runtime. Measured with
v0.2.78 and with a tree binary built from `df9927b92` (the repro prints
`1 1 1 1 0`; fixed it prints `2 3 4 5 7`):

| Form | Result before the fix |
| --- | --- |
| `_p := __yo_incr_rc(c)` | call deleted |
| `m = __yo_incr_rc(c)` (`m : unit`) | call deleted |
| `t := (__yo_incr_rc(c), i32(2))` | call deleted |
| `x := { __yo_incr_rc(c); i32(5) }` | call deleted |
| `x := { unsafe(consume(p.* = i32(7))); i32(5) }` | store deleted |
| `x := { consume(f(p)); i32(5) }` | call deleted |
| `x := { consume(b); i32(6) }` (`b` an `Rc`) | release deleted: leak |
| `_a := consume(unsafe(memset(…)))` / `consume(unsafe(putchar(…)))` | extern call deleted |
| statement `__yo_incr_rc(c);`, `consume(__yo_incr_rc(c));` | emitted |
| a struct field, record field, argument, `if`/`match` arm | emitted |

## Root cause

Two halves:

1. **The evaluator records a known `()` for a runtime effect.** The RC
   builtins (`__yo_incr_rc`, `__yo_decr_rc`, their atomic forms,
   `__yo_dyn_drop`/`__yo_dyn_dup`, `__yo_sometype_drop`/`__yo_sometype_dup`,
   `__yo_drop_array_element`, `__yo_drop_tuple_element`) in
   `src/evaluator/builtins/rc-fns.yo`, `va_start`, and `consume` set
   `ExprInfo.value` to `UnitVal` unconditionally. A known value is the
   evaluator's statement that the expression needs no runtime code (AGENTS.md:
   `.None` means a runtime value). The begin evaluator
   (`src/evaluator/exprs/begin.yo`, `has_runtime_side_effects`) folds a block
   whose non-tail statements all have concrete values to its tail value, and
   `generate_expr` renders a tuple with a known `TupleVal` straight from the
   value, so the call inside never reaches the C.
2. **Two codegen consumers discard a unit right side's rendered text.** Some
   generators return their statement instead of emitting it
   (`__yo_incr_rc(c)` renders `__yo_incr_rc(c)`, `consume(f())` renders
   `f()`); the cond and match arms, tuple elements and the temp-named arm of a
   binding already emit such text as a statement
   (`issues/fixed/cond-unit-arm-statement-is-dropped.md`,
   `issues/fixed/binding-a-unit-returning-call-emits-invalid-c.md`). The
   binding arms without a temp name (`src/codegen/exprs/init-assignment.yo`)
   and the unit-place assignment (`src/codegen/exprs/assignment.yo`) skipped
   the declaration or store and dropped the text with it.

## Fix

- The RC builtins and `va_start` record `.None` (a runtime value).
- `consume(e)` records a known `()` only when it runs nothing: `e` is a type
  value, or a concretely known value that is neither an assignment nor
  released by the consume. Otherwise `.None`.
- `init-assignment.yo` emits a unit or `void` right side without a temp name
  as a statement (`_emit_unbound_rhs`); `assignment.yo` does the same for a
  unit place.

No special case names `__yo_incr_rc`.

The consultation's `clone_no_dup.yo` (`_p := __yo_incr_rc(…)` in a hand-written
clone) is a heap-use-after-free under `--sanitize address` before the fix and
prints `1 2 43 1 43` cleanly after it.
