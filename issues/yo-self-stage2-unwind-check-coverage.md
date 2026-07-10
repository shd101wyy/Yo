# yo-self codegen: effect-unwind checks missing on method-call emission paths (stage-2 crash + fixpoint blocker)

## Status

OPEN (2026-07-10). Current stage-2 runtime frontier after the
ref-struct-get() dup chain and the frontend fidelity fixes landed
(6e2313264, 66326af85).

## Symptom

The stage-2 binary (built from /tmp/stage2-v12.c, clang -O2, 0 errors)
SIGSEGVs evaluating the 6-comment sandbox prelude (/tmp/s2box):

- -O0 build: NULL `rhs_evaled` reaches `ast_expr_is_fn_call` in the
  assignment control-flow validator after a swallowed "Variable foo not
  found" throw.
- -O2 build: UAF — crash address is ASCII (`"check: p"`) — a freed
  object's memory reused by a println buffer, read as a pointer, inside
  `evaluate_anonymous_module_begin_exprs`.

Stage-1 (TS-compiled) handles the same input gracefully.

## Root cause (quantified)

`grep -c __yo_effect_escaped`:

- TS-emitted reference (/tmp/s1-ref-v2.c): **32,911**
- stage-2 (/tmp/stage2-v12.c): **3,216**

yo-self codegen emits the post-call unwind check at ~10% of the sites TS
does. Concrete example — `parse()` (parser.yo:1448):

- TS emission (fn_yodb87f9d4_id_511_parse): BOTH calls (`Parser.new`,
  `p.get_program(exn)`) wrapped in
  `__yo_effect_escaped = 0; call; if (__yo_effect_escaped) { drops; return {0}; }`.
- stage-2 emission (yo_id_228309 / yo_id_236592): NEITHER call has any
  check — after a throw deep inside, execution CONTINUES with a garbage
  result (NULL AstExpr at -O0; UAF at -O2).

## Why the coverage differs

- TS computes `callMayUnwind` (other-fn-call.ts:1205) and calls
  `emitEffectUnwindCheck` from **6 sites** (other-fn-call.ts:1384, 1517,
  1702, 1718, 1808 + functions/generation) — covering void calls,
  temp-var calls, and METHOD calls.
- yo-self computes `ou_may_unwind` (`_call_may_unwind`,
  other_fn_call.yo:709 — the predicate itself looks faithful;
  `type_is_control_bound` DOES recurse into struct fields so
  `exn : Exception` qualifies) but consults it on only ONE call-shape
  branch (other_fn_call.yo:1406 → emissions at 1433/1471/1592/1622).
  METHOD-call emission paths (property-access callees like
  `Parser.new(...)`, `p.get_program(exn)` — the dominant call shape in
  yo-self source) never compute or emit the check.

## Fix plan (faithful port)

Map each TS emitEffectUnwindCheck site to the corresponding yo-self
emitter branch and add the missing computation + emission:

1. other-fn-call.ts:1384 (void-result call) ↔ present.
2. other-fn-call.ts:1517 (temp-var call) ↔ present.
3. other-fn-call.ts:1702/1718 (method-call result paths) ↔ MISSING in
   yo-self's method/property-access call emission.
4. other-fn-call.ts:1808 ↔ check.
5. functions/generation.ts site ↔ check.

The `_call_may_unwind` inputs at the method branch need the resolved
method Func type's param types (g_method_callee_types side-table has the
resolved method type when ExprInfo lacks it).

Gates after: corpus 112/112 (the io_async files are the unwind-sensitive
ones), check ./std 153/153, stage-2 emit ×2 byte-identical, clang 0
errors, sandbox `/tmp/s2box` check t.yo must print the same
"Variable foo not found" error as stage-1 (no SIGSEGV), real
`std/prelude.yo` must parse >0 exprs. Then stage-3 emit + fixpoint diff.

## Repro

```bash
./yo-cli compile yo-self/main.yo --release -o /tmp/yo-self-bin
YO_MAIN_STACK_MB=16384 /tmp/yo-self-bin compile yo-self/main.yo --emit-c --skip-c-compiler -o /tmp/stage2
clang -std=c11 -w -O2 /tmp/stage2.c -o /tmp/s2
cd /tmp/s2box && /tmp/s2 check t.yo   # rc=139 today; must match stage-1
```
