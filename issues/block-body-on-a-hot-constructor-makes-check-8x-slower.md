# Wrapping `new_expr_info`'s expression body in a block makes `check` ≥8x slower

**Status:** OPEN, measured 2026-09-21. Surfaced while instrumenting the
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
