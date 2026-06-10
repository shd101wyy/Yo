# Heterogeneous trait-method overloads: call-site dispatch re-evaluates param types in an env without the prelude

**Status: OPEN — blocks `plans/SLICE_REWORK.md` step 1 (`String == str`).**

## Minimal repro (user file, TS compiler)

```rust
open(import("std/string"));
W :: struct(v : i32);
impl(
  W,
  Eq(str)(
    (==) : (fn(self : Self, other : str) -> bool)((other.len() == usize(3))),
    (!=) : (fn(self : Self, other : str) -> bool)((other.len() != usize(3)))
  )
);
t :: (fn(w : W) -> bool)((w == "abc"));   // ← fails
export(t);
```

`./yo-cli check` →

```
Error: Variable "str" not found.
    (==) : (fn(self : Self, other : str) -> bool)(…)
                                     ^   (the impl's annotation, blamed from the call site)
```

The impl itself registers fine (`check` of the defining file alone passes).
The failure fires when the **call site** dispatches `w == "abc"`: the
registered method's parameter type is re-evaluated from its AST annotation in
an environment that lacks the prelude binding `str`. With two same-name
overloads (`Eq(W)` + `Eq(str)`), dispatch then only offers the homogeneous
one and the heterogeneous call fails:

```
No matching call found with arguments: x == "hello"
Available functions:
  - (String) fn(self : String, other : String) -> bool    ← Eq(str) overload missing
Failed to synthesize types for parameter "other"
```

## Secondary finding (same root family)

During impl-method **definition** evaluation, a body that needs the sibling
`(==)` cannot resolve it once two overloads exist:
- `Self.(==)(self, other)` — "No matching call" (qualified-static form does
  not disambiguate by argument types);
- infix `self == other` — same;
- the `Eq` trait's `?=` default for `(!=)` (`not(Self.(==)(lhs, rhs))`) —
  same (binds the wrong overload).

Workaround used in `std/string/string.yo`: the `(!=)` bodies are fully
inline (no dispatch). That unblocks REGISTRATION but not call sites.

## Suspected location

The method-dispatch path that re-evaluates a registered method's
FunctionType from its AST at the call site (`reEvaluateFunctionType`,
`impl.ts:1484` family / `evaluateFunctionParameterTypeAgain`) builds its
evaluation env from the trait/impl context without the defining module's
import/prelude scope — `Self` resolves (bound specially) but module-level
names like `str` in annotations do not. Homogeneous impls never hit it
because their annotations are `Self`.

## Why it matters

`plans/SLICE_REWORK.md` migrates ~2186 `x.as_str() == "lit"` call sites to
`x == "lit"`, which requires `Eq(str)` on `String` dispatching correctly
beside `Eq(String)`. The std impls are written and check-green
(`std/string/string.yo`); this dispatch bug is the sole blocker.

Fix TS-first, port to yo-self (same dispatch machinery exists in
`yo-self/evaluator/calls/`), add the repro as a regression test.
