# A blanket reference impl's specialized trait record registers too late for the declaration walks

**Severity:** S2 (the branch that adds it fails G-B; the emitted C does not compile — no silent miscompilation; the fix already exists on the stacked branch)

## Verbatim error

```text
/tmp/c4pos.c:839:3: error: unknown type name '__yo_t_6153713254522190081'
1 warning and 1 error generated.
yo: error: compile: C compiler failed (exit 1) on .../c4-mut-ref-ref-field-lend-pos.c
```

G-B row:

```text
  FAIL c4-mut-ref-ref-field-lend-pos: positive control COMPILE-FAIL under ASan
origins unsound (G-B): 312 passed, 1 failed
```

## Reproducer

`tests/origins/unsound/c4-mut-ref-ref-field-lend-pos.yo` (c4's #1943 positive control) on a tree with
the prelude's blanket `Eq(&T)` / `Ord(&T)` impls (G2 piece 3, `vbd/g2-piece3`):

```bash
yo compile tests/origins/unsound/c4-mut-ref-ref-field-lend-pos.yo \
  --std-path ./std --sanitize address --allocator system -o /tmp/c4pos
```

## Root cause

The blanket impls (`impl(generic(T : Type), where(T <: Eq(T)), &T, Eq(&T)(...))` and the `Ord` twin,
`std/prelude.yo`) make comparisons through a generic bound instantiate the impl's specialized trait
record for the program's `T`. That record type registers during body evaluation — after the pass in
which the declaration walks (`codegen/functions/declarations.yo`, `constructors.yo`,
`types/generation.yo`) already visited the type registry — so the emitted C contains a use of
`__yo_t_<id>` with no declaration.

## Evidence

- With the hunk (piece 3's prelude): the compile above fails with the undeclared type.
- With the hunk removed (develop's `std/prelude.yo`, same binary): rc=0.
- With the stacked G3 binary (`yo-g3a4`): rc=0 — G3's registry-walk rewrite declares a type
  registered during a pass itself and records it in `on_demand_body_cnames`
  (VERDICTS-59 Q2; `vbd/g3`).

## Fix

Land G3's walk rewrite (the `on_demand_body_cnames` on-demand hook) with or before the blanket
impls: `vbd/g2-piece3`'s G-B is green only when stacked with `vbd/g3`. The G-B row above is the
test: it fails on piece 3 alone and passes with G3's walks (verified 2026-11-14 with `yo-g3a4`).
