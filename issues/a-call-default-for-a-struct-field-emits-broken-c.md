# A CALL expression as an optional struct-field default passes check and emits broken C

**Severity:** S2 — a valid construct is accepted by `yo check` and fails only at the C-compile stage with an opaque generated-C error; found 2026-09-29 while landing the audit §3 `relatedInformation` work (`plans/LSP_AUDIT_2026-09-29.md`).

## Reproduction

`issues/repros/call-default-struct-field-emits-broken-c.yo`:

```rust
S :: struct(x : usize, (xs : ArrayList(usize)) ?= ArrayList(usize).new());
make :: (fn() -> S)(S(x : usize(7)));
main :: (fn() -> unit)({
  s := make();
  n := s.xs.len();
  println(s.x.to_string() + n.to_string());
  ()
});
```

`yo check` passes. `yo compile` (reproduced with the installed v0.2.45 seed
AND with this tree's own freshly built binary, so it is not a seed gap)
fails at the C stage:

```
error: expected expression
  ... _file___… = (…){ .x = …, .xs = (((__yo_t_…* (*)())/* Error: no C
  function name for func value yo_id_…__ret_R_gs_yo_id_…_usize */)()) };
```

The optional-field default `ArrayList(usize).new()` — a CALL — is lowered
to a function VALUE at the struct-literal defaulting site, and the C writer
has no name for it. Constructor-style defaults that are not plain calls
work: `(repair : Option(Repair)) ?= Option(Repair).None` (an enum
constructor) is used across `src/` today, which is why this went unseen.

## Blast radius

Bounded and rare: any field whose `?=` default is a call (a `new()`, a
`String.new()`, …). `check` and the evaluator accept it, so nothing warns
until the C compile.

## Fix direction

The struct-literal defaulting path should EVALUATE the default expression
at the literal site (it already has the evaluator at hand — `check`
accepts it) rather than embedding it as a func value the C writer cannot
name. A `check`-stage diagnostic rejecting call defaults is the smaller
fix if evaluating them is unsound for some reason.

## Workaround (what the LSP code does)

Make the field non-optional and pass the default explicitly at every
construction site (`related : ArrayList(RelatedInfo).new()` in
`src/lsp/diagnostics.yo`).

## Root cause narrowed (2026-10-01 closeout session)

The default IS evaluated at definition time (`src/evaluator/types/field.yo`
`?=` arm: `evaluate_expression_raw(dv_expr, …)` with a comptime-known-value
gate — that is why `check` passes). For `ArrayList(usize).new()` the
resulting EvalValue is a FuncVal-shaped artifact of the comptime generic-
method specialization (`yo_id_…__ret_R_gs_yo_id_…_usize`), which
`comptime_value.yo`'s struct-value emission cannot name in C. Two facts for
the fix:

- The field record retains `default_value_expr` — the literal-site fix the
  issue proposes (evaluate the default EXPRESSION at each construction,
  which is also the correct ALIASING semantics for a mutable container
  default: sharing one comptime-evaluated ArrayList across every literal
  site would alias the same container) has the expression available.
- A `check`-stage rejection of FuncVal-typed defaults would also close the
  hole (smaller, but rejects a program that could instead work).
