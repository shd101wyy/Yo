# yo-self codegen: effect-unwind checks missing on method-call emission paths (stage-2 crash + fixpoint blocker)

## Status

PARTIALLY RESOLVED (2026-07-11, commit 5a5d28d15) — the sandbox-prelude
crash is FIXED: method-call unwind coverage (codegen method branch +
evaluator temp attach, TS function.ts:2263) and the multi-statement
fn-body TAIL deferred-dup port (generation.ts:1699-1754; tail temp
declared via get_variable_type_string). The stage-2 binary now handles
/tmp/s2box exactly like stage-1 (graceful "Variable foo not found",
rc=0), evaluates the REAL std/prelude.yo (trivial file check rc=0), and
its emission is deterministic (stage-2 emit ×2 byte-identical).

REMAINING (next frontier): the full self-compile still dies — stage-3
emit rc=133 (SIGTRAP malloc abort). Bisect: `check yo-self/token.yo`
rc=0, `check yo-self/expr_info.yo` rc=133, `check yo-self/parser.yo`
rc=133. Smallest repro: YO_MAIN_STACK_MB=16384 /tmp/s2v16 check
yo-self/expr_info.yo (heap-corruption abort). Guard-malloc pin
(DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib under lldb): first bad
access inside the stage-2 emission of **evaluate_initialization_assignment**
(yo_id_236636 in /tmp/stage2-v16.c, offset +3264) — reading freed memory
while evaluating expr_info.yo's top-level `::`/`:=` bindings. REFINED PIN (gmalloc + disassembly): the faulting sequence inside
yo_id_236636 (evaluate_initialization_assignment) is
`temp = yo_id_224488(table, id); if (temp.tag == SOME) { dup(temp.value->field...) }`
where **yo_id_224488 = expr_info_table_get** — the table returns an
ExprInfo whose memory is FREED (guarded page). I.e. the stage-2 binary
over-releases an ExprInfo the table still references — the ExprInfo-table
UAF class (see memory yo-self-macro-dispatch-corruption-fixed for the
previous instance) — but this time in STAGE-1'S EMISSION of the
evaluator's own table/dup code.

Minimal repro (5s, no rebuild): any nontrivial import —
printf 'open(import("std/fmt"));\nx :: "p";\nexport(x);\n' > /tmp/t.yo
YO_MAIN_STACK_MB=16384 /tmp/s2v16 check /tmp/t.yo # rc=133
Under gmalloc the first bad access is deterministic at yo_id_236636+3264.
NOTE: content bisection is UNRELIABLE for this bug (UAF visibility depends
on allocation patterns — some richer probes "pass" while corrupted).

VERIFIED: the emitted HashMap.get for the ExprInfo table (yo_id_12570…,
called by expr_info_table_get) is RC-correct — net +1 (double-incr +
single-decr of bucket.value; the earlier get()-dup fixes reached it). So
the table-held ExprInfo is freed by a DIFFERENT over-release: an ExprInfo
alias somewhere in the emitted evaluator is dropped without a matching
dup (candidates: expr_info_table_set overwrite dropping while borrowed
aliases live, begin.yo's last_info alias flow, or scope-end drops of
`info` locals that were bound WITHOUT the +1 in some emission shape).

FURTHER VERIFIED: emitted HashMap.set (yo*id_12568…) stores the ExprInfo
at net **+2** (incr(value) + temp_dup incr; wrapper drops the displaced
old entry correctly) — over-retained, so the premature free does NOT come
through table_set/get. Remaining suspects, in order: (1) an ArrayList
field SHARED between two ExprInfos without dup (e.g. begin.yo's
shared-id clobber carries: `out_info.deferred_dup_expressions =
last_info.deferred_dup_expressions`, runtime_arg_exprs_in_order,
index*\* carries) — both infos' disposals drop the same list →
double-free → heap corruption; (2) the ~15 missing dups in stage-2's
evaluate_initialization_assignment vs TS-ref (62 vs 77 dups; TS also has
2672 vs 127 drops from full escape-path cleanup — stage-2's thinner
escape cleanup is a separate fidelity gap). Fresh TS reference:
/tmp/s1-ref-v3.c.

Next: find which stage-2-emitted drop releases a table-held ExprInfo —
candidates: (a) the arm-dup/arm-drop pairing around expr_info_table_get
match arms (nullable-ptr Option(ExprInfo) cleanup dropping the TABLE's
reference), (b) an over-drop in expr_info_table_set replacing entries,
(c) interaction with today's attach_temp_variable_to_expr addition
(more table-held infos mutated). Differential: extract the table-get
match-arm cleanup shape from /tmp/stage2-v16.c vs a FRESH TS reference
emission (regenerate s1-ref: ./yo-cli compile yo-self/main.yo --emit-c
--skip-c-compiler -o /tmp/s1-ref-v3).

ORIGINAL ISSUE (2026-07-10): Current stage-2 runtime frontier after the
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

1. other-fn-call.ts:1384 (void-result call, gated on callMayUnwind) and
   :1517 (temp-var-result call, same gate) — in TS these cover ORDINARY
   METHOD CALLS too, because TS compiles a method call through the same
   main call path (receiver as first arg). yo-self's METHOD-call emission
   branch is separate and has NO ou_may_unwind computation/emission —
   that's the dominant missing coverage (`Parser.new(...)`,
   `p.get_program(exn)`).
2. other-fn-call.ts:1702 (direct local-handler atom call, install-point
   check via isHandlerAtomBoundLocally) and :1718 (`exn.throw(...)`
   effect-record-field call, propagate) ↔ verify yo-self equivalents.
3. other-fn-call.ts:1808 ↔ verify.
4. functions/generation.ts site ↔ verify.

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
