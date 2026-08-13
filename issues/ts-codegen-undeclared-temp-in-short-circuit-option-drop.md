# TS codegen: undeclared temp referenced in a drop for a short-circuit `||` chain ending in `Option.is_some()`

**Status: OPEN (minimization pending).** Found 2026-08-13 while building the
method-miss fix (`issues/fixed/yo-self-method-miss-degrades-to-unit.md`).

## Symptom

`./yo-cli compile yo-self/main.yo --release` (TS compiler, tree at
`swallow/fatal-trial-handler` + the intermediate gate shape below) emitted C
that clang rejected:

```
/tmp/yo-hs23.c:305102:69: error: use of undeclared identifier '_yo73831c64_temp_422012'; did you mean '_yo73831c64_temp_422072'?
 305102 |       fn_yo1c2129e9_id_56418___drop((__yo_enum_yo1c2129e9_id_56400)(_yo73831c64_temp_422012));
```

The drop targets a temp id that was never declared in that scope (only
`_yo73831c64_temp_422072`, a `bool`, exists — note the near-identical id). The
second clang error shows the drop call also casts a non-scalar enum struct.

## Trigger

The source shape, inside `yo-self/evaluator/calls/function.yo`'s
`evaluate_function_call` — deep inside a `match` arm of a `cond` in a very
large function:

```rust
can_call_valueless := (
  (is_function_type(callee_ty_none) || is_some_type(callee_ty_none))
  || extract_fn_trait_from_type(callee_ty_none).is_some()
);
if(!(can_call_valueless), { ... exn.throw ...; return(expr); });
```

`extract_fn_trait_from_type` returns `Option(TypeValue)` — an RC-managed
temp born in the short-circuit `||`'s LAST operand. The emitted drop for that
temp appears to land in a scope where the temp's C declaration does not exist
(short-circuit operands emit as nested branches; the drop was emitted with a
stale/foreign temp id).

Note two near-misses that do NOT reproduce it:

- The same chain via a `match(...)` first operand (`.Func({ result : _ }) =>
true`) compiled — but that binary miscompiled/regressed
  `tests/iterator_combinators.test.yo` at runtime, possibly the same drop
  family landing "valid but wrong" instead of "invalid C" (unproven; the
  regression also has a semantic explanation via silent dry-run channels —
  see the gate's final scoped form).
- A standalone small program with `(a || b) || make_opt(n).is_some()`
  (`Option` of an RC-carrying enum) compiles and runs clean — the bug needs
  the surrounding context (huge fn, nested cond/match arm, `TypeValue`-sized
  enum) to fire.

## Next steps

- Minimize: start from `evaluate_function_call`'s arm structure — a fn with a
  `cond` arm containing a `match` arm containing the `||` chain; grow until
  the undeclared-temp drop appears. The emit-side suspects are the
  short-circuit lowering's temp scoping + the dup/drop pass
  (`src/codegen/exprs/` boolean/short-circuit emission).
- The final gate shape in-tree avoids the pattern (named locals, staged
  `if`s) — the workaround is documented at the gate site.
