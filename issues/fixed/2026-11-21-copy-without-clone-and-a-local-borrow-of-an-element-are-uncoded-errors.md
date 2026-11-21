# `derive(T, Copy)` without `Clone` and a local borrow of an element (`&xs(i)`) are uncoded errors

**Severity:** S3 — two deliberate rejections had no error code (no `yo explain`, no JSON code for tools), and the `Copy` one cited a plan document in its user text.

## Symptoms

```yo ignore
P :: struct(x : i32);
derive(P, Copy);
```

```text
error: derive on "P" failed: Type "P" cannot implement "Copy" without "Clone": Copy requires Clone, as Rust's Copy: Clone (plans/VALUES_BY_DEFAULT.md decision 36), and the compiler never writes the Clone impl. Write derive(P, Copy, Clone), or derive(P, Clone) beside impl(P, Copy()).
```

```yo ignore
mut(xs) := ArrayList(i32).new();
xs.push(i32(1));
y := &xs(usize(0));
```

```text
error: A local borrow (`y := &place`) needs a place: a variable, or a field path rooted at one (`x`, `h.n`, `a.b.c`). To borrow an ELEMENT of a collection, iterate it with `for(&coll, x => ...)`; to hold a computed value, bind it with `:=` and no sigil.
```

Both rejections are by design: decision 36 makes `Copy` require `Clone` and the compiler never writes
the `Clone` impl; a local borrow names a variable or a field path, and an element is borrowed through
the collection's projection (`xs.index(i)`, `docs/en-US/OWNERSHIP_AND_BORROWING.md`).

## Root cause

- The impl-site checks (`receiver_kind_trait_violation_msg`, `check_self_constraints_violation_msg`,
  `src/evaluator/trait-checking.yo`) returned a bare `Option(String)` through the
  `CheckSelfConstraintsFn` hook, and the three throw sites in `src/evaluator/values/impl.yo` and
  `trait-checking.yo` wrapped it uncoded. The derive re-raise carries the generated impl's code, so
  there was none to carry.
- `_evaluate_inout_local_binding` (`src/evaluator/exprs/initialization-assignment.yo`) threw its
  `place_recipe` text uncoded, and no code fit: E0911/E0912 are about live borrows, E0914 about call
  markers.

## Fix

- The hook returns an `ImplRuleViolation(message, code)`. `Copy` without `Clone`, a `Copy` type with
  a field that is not `Copy`, and an unsatisfied `where(Self <: …)` bound of a trait carry E0602
  (required trait not implemented); the derive re-raise carries it to the `derive` line. The plan
  reference left the message. `yo explain E0602` names the `Copy: Clone` rule.
- New code E0927 (`E_BORROW_OF_NON_PLACE`): a local borrow of something that is not a place. The
  help names the projection (`r := xs.index(i)`, `xs.index_mut(i)` under `&mut`) and the borrowed
  `for`. Registered in `src/diagnostics.yo` and `src/diagnostics-registry.yo` (English and Chinese
  explanation, a bad/good pair). E0925 stays reserved for the declared-union rule (N2c).

## Tests

`tests/cli-cases/check-ownership-rejections-are-coded` (`copy-without-clone.yo`,
`borrow-of-an-element.yo`): `error[E0602]` and `error[E0927]`; before the fix both lines read
`error:`. `tests/cli-cases/explain-list` gains E0927. `tests/internal/diagnostics-registry.test.yo`
checks the new entry's examples (the bad one reports E0927, the good one checks clean).
