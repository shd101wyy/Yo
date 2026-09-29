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
