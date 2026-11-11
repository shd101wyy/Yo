# An untyped module-level binding may carry an origin, so a global holds a reference to a dead local

**Severity:** S1. `mut(G) := Option(&i64).None;` passes `yo check`, so a function can store a reference to its own
local in the global (`G = .Some(&s)`) and a later caller reads it after the frame died (ASan:
stack-use-after-scope). The typed spelling `(mut(G) : Option(&i64)) = .None` is E0909. An initializer block that
returns a reference to its own local (`G := { s := …; Option(&i64).Some(&s) }`) also passes `check`, and its C
fails to compile. Pre-existing: v0.2.76 accepts all three and rejects the typed form with E0909 too.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A40). Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-an-untyped-module-level-binding-may-carry-an-origin-so-a-global-holds-a-reference-to-a-dead-local.yo`
(negative, expects E0909):

```yo
{ println } :: import("std/fmt");
mut(G) := Option(&i64).None;
_set :: (fn() -> unit)({
  s := i64(1234567);
  G = .Some(&s);
});
_clobber :: (fn() -> i64)({
  a := i64(7);
  (a + a)
});
main :: (fn() -> unit)({
  _set();
  _ := _clobber();
  v := match(&G, .Some(r) => r.*, .None => i64(0));
  println(`OUT: ${v.to_string()}`);
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710 and v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system --cc clang -o t && ./t
==…==ERROR: AddressSanitizer: stack-use-after-scope
```

- `…-holder.yo` (negative, E0909): the same through `H :: struct(r : &i64)`, with `mut(G) := H(r : &S0)` and
  `G = H(r : &s)` in `_set`: stack-use-after-scope.
- `…-init-block.yo` (negative, E0909): `G := { s := i64(1234567); Option(&i64).Some(&s) };`. `check` accepts it;
  `compile` fails in clang with `use of undeclared identifier '__yo_v_s_…'`, because the emitted initializer names
  the block local outside its scope.
- `…-pos.yo` (positive control): `mut(G) := Option(i64).None`, storing the value instead: prints `OUT: 1234567`.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `mut(G) := Option(&i64).None`, then a function stores `&local` | accepted, stack-use-after-scope | E0909 |
| `mut(G) := H(r : &S0)` (a holder struct), then a function stores `H(r : &local)` | accepted, stack-use-after-scope | E0909 |
| `G := { s := …; Option(&i64).Some(&s) }` | accepted, C compile failure (undeclared identifier) | E0909 |
| `(mut(G) : Option(&i64)) = .None` (the typed spelling) | E0909 | E0909 |
| `G := RefCell(&i64).new(&_A)` | rejected (the cell-payload error for N2d, not E0909) | E0909 |
| `thread_local(mut(G)) := Option(&i64).None` | rejected ("cannot hold a reference-counted type") | E0909 |

## Root cause

Confirmed by reading the source. The module-level E0909 check lives only in `evaluate_assignment`
(`src/evaluator/exprs/assignment.yo`), under `if(is_typed_binding_lhs, …)`: for a typed binding
`(G : T) = v`, it looks the new variable up, and when `is_module_level()` and
`type_carries_origin(&variable_value_type(…))` it throws `no_origin_position_error("A module-level binding", …)`.
The `:=` form never reaches that code. `evaluate_initialization_assignment`
(`src/evaluator/exprs/initialization_assignment.yo`) has only the module-level `type_is_control_bound` check (the
`ctl` escape rule), and its only `type_carries_origin` test is the N2b `bind` call, which is guarded by
`ctx.is_evaluating_function_body_or_async_block.is_some()` and so never runs at module level. A module-level `:=`
binding therefore gets neither the E0909 wall nor a registered loan. Inside a function the write `G = .Some(&s)` is
judged as a store into a binding whose type was accepted, so nothing compares `s`'s origin with the global's.

The `-init-block` form is the same gap seen from codegen: the initializer's block-local reference survives into the
module-level initializer, which is emitted at file scope where `s` does not exist.

## Expected

E0909 at the declaration for every spelling: "A module-level binding requires an `Escapable` type"
(`plans/backlog/REFERENCES_AND_ORIGINS.md` O4 "module-level bindings: no, initially", O10, §7 "Module-level
origins": no frame owns the places it would borrow). P12 (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md`) later
admits a module-level binding whose only origin is ∅ (`static`); `&local` origins stay E0909 under it. The check
belongs where both spellings meet (the new variable's type at module level), not on the typed-binding path.

## Test

With the fix: the three negative programs and the positive control move to `tests/origins/unsound/`. The corpus
row `global-refcell-origin` (`tests/origins/corpus.tsv`) uses only the typed spelling; add its `:=` twin
(`global-option-ref-untyped`, `mut(G) := Option(&i64).None`, `neg`, E0909) so both paths stay covered.
