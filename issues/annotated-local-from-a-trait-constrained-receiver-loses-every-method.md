# A type-annotated local loses EVERY method on its type when its value comes from a trait-constrained receiver

**Status: OPEN.** Severity: **valid code rejected** at check time, with a
diagnostic that names the method rather than the binding. Found 2026-09-04
during the std-API-audit re-measurement of the `std/imm` set-pair dedupe row,
at v0.2.24.

Adding a redundant type annotation to a local — the same type the compiler
infers one line later — turns every subsequent method call on that local into
`error: No matching call found`. Removing the annotation compiles and runs.

## Reproducer

`issues/repros/annotated-local-from-trait-receiver-loses-methods.yo` (source inline below — commit it at that path alongside this doc):

```rust
{ Set } :: import("std/imm/set");
{ List } :: import("std/imm/list");
{ assert } :: import("std/assert");
{ println } :: import("std/fmt");
SetLike :: (fn(comptime(T) : Type, where(T <: (Send, Acyclic))) -> comptime(Trait))(
  trait(to_list : (fn(self : Self) -> List(T)))
);
impl(
  generic(T : Type),
  where(T <: (Eq(T), Hash, Send, Acyclic)),
  Set(T),
  SetLike(T)(to_list : (fn(self : Self) -> List(T))(self.to_list()))
);
first :: (fn(generic(S : Type, T : Type), a : S, where(T <: (Send, Acyclic), S <: SetLike(T))) -> bool)({
  (cur : List(T)) = a.to_list();
  cur.head().is_some()
});
main :: (fn() -> unit)({
  s := Set(i32).new().insert(i32(1));
  assert(first(s), "has a first element");
  println("ok");
});
export(main);
```

```
$ yo check issues/repros/annotated-local-from-trait-receiver-loses-methods.yo
error: No matching call found with arguments:
(cur.head)()
   --> issues/repros/annotated-local-from-trait-receiver-loses-methods.yo:16:6
   |
16 |   cur.head().is_some()
   |      ^
yo: error: check: 1 file(s) failed evaluator coverage
```

Expected: `ok`, rc 0 — which is exactly what the file produces with the single
character-level change `(cur : List(T)) = a.to_list();` → `cur := a.to_list();`
(`yo compile ... --optimize 2` rc 0, runs rc 0).

It is not `head` that is missing. Every method on the type is gone — swapping
the body line reproduces the same error for each:

```
error: No matching call found with arguments: (cur.len)()
error: No matching call found with arguments: (cur.get)(usize(0))
error: No matching call found with arguments: (cur.tail)()
```

`head`, `len`, `get` and `tail` are all in the one `impl` block at
`std/imm/list.yo:63-100`.

## Boundary (v0.2.24) — the annotation AND the trait-constrained receiver are both required

| # | shape | result |
| --- | --- | --- |
| 1 | `(cur : List(T)) = a.to_list()` where `a : S`, `where(S <: SetLike(T))` | **BROKEN** |
| 2 | identical but `cur := a.to_list()` | OK, runs |
| 3 | `(cur : List(T)) = l` where `l : List(T)` is a plain parameter, **same signature, same `where(S <: SetLike(T))` constraint still present** | OK |
| 4 | `(cur : List(T)) = s.to_list()` where `s : Set(T)` — a concrete receiver, no trait constraint | OK, runs |
| 5 | both bindings in one function: `(cur : List(T)) = a.to_list(); cur2 := a.to_list(); cur2.head()` | OK — `cur2` resolves; only `cur` is poisoned |

Row 3 rules out "the annotation type is broken inside a where-constrained
generic". Row 4 rules out "the trait method's return type is broken". Row 5 is
the decisive one: the damage is confined to the annotated VARIABLE, not to the
`List` type, not to the call, and not to the function.

## Root cause

`src/evaluator/exprs/initialization_assignment.yo`, `evaluate_initialization_assignment`.

The binding's type is chosen in two branches (`:354-415`). Without an
annotation it is the RHS's own type:

```rust
.Some(rt) => {
  lhs_type = rt;
  ...
}
```

With an annotation it is the ANNOTATION's, and the RHS's synthesized type is
used only for a compatibility check and then discarded (`:385-414`):

```rust
pre_type := match(actual_lhs_info_opt, .Some(ali) => ali.ty, .None => t_unit());
synth := synthesize_expr_and_type(rhs, pre_type, env, ctx);
...
if(!are_types_compatible(pre_type, synth.ty), { ...throw... });
lhs_type = pre_type;          // <-- src/evaluator/exprs/initialization_assignment.yo:414
```

`lhs_type` becomes `final_lhs_type` (`:584`) and is what the variable is
registered with (`add_variable_to_env`, `:667-671`). So `cur` carries the
`TypeValue` produced by evaluating the type EXPRESSION `List(T)` in the generic
function's environment — where `T` is the function's own abstract forall —
rather than the `List` instance the trait method actually returned.
`are_types_compatible` passes: both render as the same
`<struct:struct_yo_id_15424>`, so nothing objects. But method dispatch on the
variable then finds nothing, the property access `cur.head` degrades to a
`unit`-typed callee, and the call throws at
`src/evaluator/calls/function.yo:6706-6718` — the "an undefined METHOD on a
concrete receiver" gate, confirmable with `YO_DEBUG_CTFE=1`:

```
[vcall-throw] callee=(cur.head) ty=unit
```

This is consistent with every row of the boundary table. Row 3 (`(cur : List(T)) = l`
from a plain `List(T)` parameter) works because there the annotation and the RHS
are the SAME instance, so picking `pre_type` costs nothing. Row 5 is the proof
that the damage is per-variable and not per-type: the inferred `cur2 :=
a.to_list()` in the very same function body, from the very same call, takes the
`lhs_type = rt` branch and keeps its methods.

The port left a note in the same function, immediately above the line that
freezes the choice into `final_lhs_type` (`initialization_assignment.yo:582-583`),
saying what is missing:

```
// NOTE: SomeType resolvedConcreteType copy is skipped in Phase 2w.
// yo-self's TypeValue.SomeT does not carry resolvedConcreteType.
```

That second sentence is no longer true — `TypeValue.SomeT` carries a
`resolved_concrete` cell today (`src/codegen/exprs/closures.yo:67-107` walks it,
`src/expr_info.yo:979-998` is the id-keyed fallback registry), so the copy TS
does at this site is now implementable.

## Fix

At `initialization_assignment.yo:414`, do not discard the synthesized RHS type.
Two options:

1. **Bind the RHS's type (recommended).** Once `are_types_compatible(pre_type,
   synth.ty)` has passed, `synth.ty` is a valid inhabitant of the annotation and
   is strictly better resolved — row 2 of the boundary table proves it works in
   this exact position. Use `synth.ty` for `lhs_type` when it is compatible and
   `pre_type` still carries unresolved `SomeT`s; keep `pre_type` otherwise so an
   annotation that deliberately widens (a supertype, an `Impl(...)` carrier)
   is not silently narrowed.
2. **Copy the resolution across.** Keep `lhs_type = pre_type` and write
   `synth.ty` into `pre_type`'s `SomeT` cells via
   `register_some_resolved_concrete` — the mechanism the note at `:582` names.
   This preserves the declared spelling in diagnostics, which option 1 loses.

Option 1 is the smaller change and matches what the inferred form already does;
option 2 is closer to the TS original. Take option 1 and note the divergence in
a comment, unless a case turns up where the declared spelling must survive.

Do **not** "fix" this by telling users to drop the annotation. The annotation is
legal Yo, it is the natural way to write the loop in question, and the rule as
it stands is invisible: nothing in the error mentions the binding.

## What it blocks

`plans/STD_API_AUDIT.md` §4's `imm/*` row calls for deduplicating the
`Set` / `SortedSet` pair, which currently share 93 byte-identical lines of set
algebra (`std/imm/set.yo:60-157` vs `std/imm/sorted_set.yo:86-180`). The
dedupe works by hoisting those bodies into one generic helper over a private
`ImmSetLike(T)` trait — i.e. exactly the trait-constrained receiver above — and
the natural way to write each hoisted body annotates its intermediate
`List(T)` cursor.

## Regression test

`tests/where_clause_fn_inference.test.yo` is the right home (it already covers
`where`-constrained generic dispatch). Add one test that is verified RED first:
a private parameterized trait with one method returning a generic container,
one impl, and a generic helper that binds the method's result to an
**annotated** local and then calls a method on it. Assert the value, not just
that it compiles. Add the inferred-binding twin in the same test so a future
change that fixes one and breaks the other is caught.
