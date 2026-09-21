# Wrapping `new_expr_info`'s expression body in a block makes `check` ≥8x slower

> **RETRACTED 2026-09-21 (same day).** The analysis below is WRONG and is kept
> as provenance. Every timing in it was taken with the SEED compiler
> (v0.2.38) on PATH, and the seed predates the 2026-09-20 fix for the
> exponential template-interpolation cost
> (issues/fixed/debug-probe-line-costs-gigabytes-at-compile-time.md, landed
> in ba77dead3 — NOT an ancestor of the 0.2.38 bump). The cost was never the
> block body: it was the probe's REPORT LINE, a ten-interpolation template,
> which under the seed costs ~4^N (measured on a 12-line module: 5
> interpolations 2 s, 8 → 5 s, 9 → 16 s, 10 → 64 s; the same ten-local file
> under a tree-built compiler: 1 s). Bisecting the probe module alone found
> it: a variant with no walk, no key hashing and only counters plus the
> report line still timed out; a variant with ten globals but five
> interpolations took 2 s; string concatenation of the same ten reads took
> 1 s. The "block body" arms happened to be the ones that carried the report
> line. The lesson is recorded in
> `yo-run-tests-with-a-tree-built-compiler-not-the-seed`: measure `check`
> cost with a compiler built from the tree, never with the seed.
>
> Consequence for the probe: `type_intern_probe_record` may sit in
> `new_expr_info` / `make_default_variable` after all; nothing about a block
> body is hot. The four "refuted synthetic shapes" below were refuted because
> they had no ten-interpolation template, not because the real module is
> special.


**Status:** RETRACTED 2026-09-21 — see the banner. Surfaced while instrumenting the
evaluator for the `TypeValue` interning measurement
(plans/EVALUATOR_MEMORY_REDUCTION.md §0.4′) — the instrumentation could not
be placed because merely making room for a statement cost an order of
magnitude.

## Symptom

`src/expr_info.yo`'s `new_expr_info` is written as an EXPRESSION body:

```rust
new_expr_info :: (fn(env : Environment, ty : TypeValue) -> ExprInfo)(
  ExprInfo(env : expr_info_env_snapshot(env), ty : ty, /* ~30 fields */)
);
```

Wrapping that same literal in a block so a statement can precede it:

```rust
new_expr_info :: (fn(env : Environment, ty : TypeValue) -> ExprInfo)({
  _probe_noop := usize(0);
  ExprInfo(/* unchanged */)
});
```

| tree | `yo check ./src/expr_info.yo` |
| --- | --- |
| develop (expression body) | **37 s** |
| + block body, statement is `_probe_noop := usize(0);` | **>300 s (timeout)** |
| + block body, statement is a real call | **>600 s (timeout)** |

`yo check ./src` on the same tree ran **36 min of CPU without completing**
against a **3.5 min** baseline. Nothing else changed; the emitted literal is
byte-identical and the added statement binds an unused `usize`.

**The call is not the cause** — the no-op statement reproduces it. The block
is.

## Why it matters beyond the probe

It is a hard constraint nobody wrote down: the evaluator's hot constructors
CANNOT take a statement. `new_expr_info` and `make_default_variable` are the
two funnels every expression and every binding pass through, and both are
expression-bodied today. Any future instrumentation, caching, or accounting
placed in them pays this cost, and the failure mode is a timeout with no
diagnostic, not an error.

It is also plausibly the same family as the F8 finding already in
plans/EVALUATOR_MEMORY_REDUCTION.md (`check` cost super-linear in a nested
call shape, root-caused to a receiver re-evaluated per argument): a cost that
multiplies per call site rather than per definition.

## NOT yet distilled to a standalone repro

Four synthetic shapes were built and all check in 1–2 s, so the trigger needs
something the real module has that these do not (each is a `ref(struct)`
constructor wrapped the same way, expression body vs block body):

1. 24 plain `usize` fields, 60 call sites in one function;
2. 30 fields half `Option(usize)`, a helper CALL inside the literal, 120 call
   sites in one function;
3. same, but 120 SEPARATE caller functions (one def-time trial each);
4. 30 RC-managed fields (`Option(ArrayList(String))`, `Option(String)`,
   `ArrayList(usize)`), 60 separate caller functions.

Candidates not yet tried: the real `ExprInfo`'s field count and field TYPES
together (it carries `Option(Box(...))`, `Option(TypeValue)`, an
`ArrayList(AstExpr)` and a rare-group `Option(ExprInfoRare)`); the number of
call sites WITHIN `expr_info.yo` itself; and whether the trigger is the
`expr_info_env_snapshot(env)` call in the first field position.

## Reproduce in-tree

```bash
git checkout -b probe origin/develop
# wrap new_expr_info's ExprInfo(...) literal in { _x := usize(0); ... }
yo check ./src/expr_info.yo      # >300 s vs 37 s on develop
```
