# A local function value with a `comptime(V) : Type` parameter is called through a C function pointer

**Severity:** S2 — a valid program fails the C compile: a generic function that binds a local `fn(comptime(V) : Type, …)` value and calls it gets C code that passes the `Type` as a runtime argument (`// Unknown type: Type`) and names an undeclared function.

**Status:** open. Found 2026-10-27 while probing codegen's emittability guards for decision 43
step 1 (`vbd/d43-step1-reference-type`). The v0.2.70 seed, develop 476cfb700 and the branch emit
byte-identical C, so the bug predates the branch.

## Evidence

Reproducer: `issues/repros/2026-10-27-local-fn-value-with-comptime-type-param.yo`.

```
yo compile issues/repros/2026-10-27-local-fn-value-with-comptime-type-param.yo -o h.out
h.out.c:1980:25: error: use of undeclared identifier 'yo_id_2761206107488437310000002'
h.out.c:1983:3: error: expected parameter declarator
```

The call site is lowered as an indirect call through the local:

```
size_t … = (((size_t (*)(// Unknown type: Type, size_t))__yo_v_helper)((// Unknown type: Type)(bool), (size_t)(1ULL)));
```

## Root cause (not yet confirmed)

The local `helper := (fn(comptime(V) : Type, …) -> …)(…)` is a function value bound with `:=`
inside a generic body. Its call does not go through the specialization that a module-level
`::` helper gets (`inner :: (fn(comptime(U) : Type, …) …)` in the same position compiles).
Instead it reaches `other_fn_call`'s function-pointer arm, which spells every parameter of the
callee's type, the comptime `Type` one included. A comptime-parameter function value should
either be specialized at the call, like the `::` form, or be rejected in the evaluator with a
diagnostic. It must not be lowered to a C pointer call.
