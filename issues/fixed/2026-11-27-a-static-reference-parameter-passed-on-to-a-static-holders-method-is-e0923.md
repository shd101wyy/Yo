# A `static` reference parameter passed on to a `static` holder's method is E0923

**Severity:** S3 — a false positive with a workaround (store through `slot.* = .Some(g)`). A parameter declared
`g : &(X, static)` holds a static value (its caller was checked to pass one, VERDICTS-74 rules 2 and 3), yet
passing it on to a slot spelled over `static` is rejected.

- Filed: 2026-11-27 by the `v81-infer-first` lane, found by the positive control of
  `issues/fixed/2026-11-27-a-free-generic-function-stores-a-local-reference-into-a-callers-static-holder.md`.
- Reproduces with the v0.2.80 seed.
- **Status:** fixed on `wip/v0281-static-solve-s1`.

## Reproducer

```yo
X :: struct(n : i32);
fill :: (fn(slot : &mut Option(&(X, static)), g : &(X, static)) -> unit)({
  _old := slot.replace(g);
});
G := X(n : i32(7));
main :: (fn() -> unit)({
  mut(slot) := Option(&(X, static)).None;
  fill(&mut slot, &G);
  ()
});
export(main);
```

```text
error[E0923]: Cannot keep this value in `slot`: its type is declared over the empty origin `static` (`Option(&X)`), which holds only values that borrow no place, and the value holds `g` (decision 49; plans/backlog/REFERENCES_AND_ORIGINS.md O3).
  --> tmp/pos3.yo:3:24
  |
3 |   _old := slot.replace(g);
  |                        ^
```

The same false positive met the free generic `keep(slot, g)` once the S1 fix judged a slot solved through a type
binder (`static-generic-fn-store-pos.yo`).

## Root cause

`_static_value_offense` (`src/evaluator/utils.yo`), the value side of VERDICTS-74 rule 2 at an argument that
meets a `static` slot, first asks which by-value parameters and which named origins the value carries. A read of
the parameter `g` names `g` itself there, and those two arms never ask rule 3's question: whether the parameter's
declared slot spells `static`. Only the deep-root arm (`_static_offending_root`) asks it, and it is not reached.

## Fix

`_static_value_offense` returns no offense for a read of a parameter whose declared slot spells `static`
(`_static_slot_param`, the same test `_static_offending_root` applies to a deep root). Test: the positive control
`tests/origins/unsound/static-generic-fn-store-pos.yo` passes `g` to both `keep(slot, g)` and `slot.replace(g)`.
