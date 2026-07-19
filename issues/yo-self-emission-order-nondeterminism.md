# yo-self: function/type emission order is HashMap-bucket order, not insertion order

**Status:** ROOT-CAUSED 2026-07-19. **NOT a soundness emergency** (see the
r19 self-check below). Fix designed (below), preserved in
`issues/determinism-fix-function_order.patch` (function half only). Discovered
while landing P1 (`\u` escape decode): adding two small top-level helper
functions to `string.yo` appeared to "break" the stage2≡stage3 gate — but the
break is PRE-EXISTING (the clean tree breaks it too) and BENIGN.

## The r19 self-check — the meaningful fixpoint HOLDS

The standard gate compares `stage2` (s1's self-emit, s1 = TS-compiled yo-self)
vs `stage3` (s2's self-emit, s2 = self-compiled). These can differ WITHOUT the
bootstrap being unsound. Verified with `s2_r19pin` (the committed self-hosted
compiler): it emits its own source (`stageA`), clang → `s2_fromA`, which
re-emits (`stageB`) — **`stageA ≡ stageB` (R19PIN_SELF_FIXPOINT=HOLDS)**. So the
self-hosted compiler reproduces itself byte-identically — the bootstrap IS sound.
But `s2_r19pin`'s emit ≠ a fresh TS-built s1's emit (R19PIN_EMIT != S1CLEAN),
and the TS build is deterministic (verified same hash) — so yo-self's emission
is HOST-DEPENDENT: the TS-compiled and self-compiled binaries iterate the
function/type HashMaps in different bucket orders, producing functionally
equivalent output (same funcs/types) in different order/numbering.

**Consequence for #69:** the metric uses `s2` (self-compiled), which works and
is self-stable. The s1-vs-s2 gate divergence does NOT affect it. Validate #69
changes on the FUNCTIONAL gates (corpus/std/flips) + s2 SELF-STABILITY
(stage3 vs stage4), NOT the s1-vs-s2 strict fixpoint.

## Symptom

After adding 2 functions to yo-self source, `FIXPOINT=BROKEN`: stage2.c
(s1 self-emit) ≠ stage3.c (s2 self-emit). Both 1475 functions, but:

- Static/early func-id VALUES **match** between stage2/stage3 (sorted positions 1-786).
- Late dynamically-created specialization ids (the `yo_id_316999+` range) **differ**.
- Content is otherwise identical: the only textual diffs are global-counter
  values (`__yo_ref_spill_543` vs `_516`; `_file____User_temp_` off by 1) —
  i.e. the SAME functions emitted in a DIFFERENT ORDER, so the monotonic
  `g_ref_spill_counter` / temp counters reach different values per site.

## Root cause

TS `generateAllFunctions` / `generateFunctionDeclarations` iterate
`for (const funcId in context.functions)` — `context.functions` is a plain JS
object, so iteration is **insertion order** (deterministic given eval order,
identical for s1 and s2).

yo-self iterates `context.base.functions.keys()` — a SwissTable
`HashMap(String, CodegenFunctionEntry)` (std/collections/hash_map.yo), so
iteration is **hash-bucket order**. When the function SET changes (my 2 added
functions shift capacity/rehash/probe sequences), the bucket order of
dynamically-created specs diverges between the TS-compiled s1 and the
self-compiled s2 — different emission order → different spec-creation order →
different late func-id VALUES → non-byte-identical fixpoint.

Held "by accident" through ~30 prior commits because those MODIFIED existing
functions (same key set → stable bucket order); the first commit to ADD
source functions exposed it.

## The 9 divergent sites (all should be insertion order, per TS's 9 `for..in`)

- codegen/functions/generation.yo:554 generate_all_functions (BODY loop — primary)
- codegen/functions/generation.yo:713
- codegen/functions/declarations.yo:725 (prototype loop — MUST agree with body loop)
- codegen/functions/declarations.yo:699 (async runtime-object keys)
- codegen/types/collection.yo:657
- codegen/exprs/closures.yo:260
- codegen/functions/gc_runtime.yo:103 (.values())
- codegen/exprs/async.yo:1995 (.values())
- codegen/utils/index.yo:349 (.values())

## Fix (faithful port: insertion order)

Single choke point: EVERY registration goes through
`CodeGenContext.register_function` (utils/index.yo:322).

1. Add field `function_order : ArrayList(String)` to CodeGenContext
   (utils/index.yo:115 decl + :230 init).
2. In `register_function`, append `func_id` to `function_order` IFF it is not
   already in `functions` (JS `for..in` keeps a re-assigned key's original
   position — only NEW keys append).
3. Replace the 9 iteration sites: iterate `function_order` BY INDEX
   (`while(i < function_order.len())`) so specs appended mid-emission are
   still picked up (mirrors JS `for..in` over a growing object). For
   `.values()` sites, iterate order + `get_function_entry(fid)`.

Deterministic because registration order = collection/eval traversal order,
which is AST-driven (not HashMap-driven) and identical for s1 and s2.

## Verify

Rebuild s1 WITH the fix AND P1's 2 helper functions (the perturbation that
triggered the bug) → `FIXPOINT=HOLDS` proves the fix accommodates
function-set changes. This unblocks the whole campaign (P4 iso port, cluster
fixes) from the "adding functions breaks the fixpoint" fragility.
