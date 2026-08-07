# yo-self stage-2: errno error-enum never collected — 416 clang errors (typedef/dyn-box/temp-decl cascade)

## Status

PARTIALLY FIXED (2026-07-10): the typedef/dyn-box family (all `unknown type
name` + t782-cascade errors) is FIXED — stage-2 clang errors 416 → 265, with
ZERO unknown-type errors remaining. Root cause was NOT a collection miss:
`type_key()` returns a String that on a dedup HIT SHARES ITS BUFFER with the
canonical key stored in `g_enum_sig_keys`; the dyn-impl registration in
`codegen/functions/collection.yo` did `impl_key := type_key(concrete);
impl_key.push_str("_"); impl_key.push_string(type_key(dyn))` — the pushes
appended `_dyn_trait_...` ONTO THE STORED CANONICAL in place. Every later
`type_key(IoError)` then returned a longer key (probe showed the key growing
by one `_dyn_trait_yo_id_..._trait_yo_id_...` per dyn-impl registration, 10
distinct `__yo_tN` names for one enum), minting fresh c-names for function
code while the typedef stayed under the first name. Fix: build the impl key
in a fresh template string, plus defensive `.clone()` on the three shared-
buffer returns in `types/type_key.yo` (enum sig hit, struct cycle-guard hit,
struct structural-fallback hit).

SECOND FAMILY MOSTLY FIXED (2026-07-10, same session): 265 → 10 errors.
The match-arm deferred-dup materialization was missing — ported
match.ts:105-150 verbatim into `codegen/exprs/match.yo generate_case_body`
(same mechanism as the existing `return.yo handle_func_call_deferred_dup`):
when the arm value carries deferred dups, (1) generate the RAW expr code,
(2) DECLARE the expr's eval temp (`T <variableName> = <raw>;`), (3) emit the
dup as `T <dupTemp> = <dup of declared temp>;`, (4) the arm result is the
dup temp. Also added the undeclared-temp gate to
`generate_deferred_dup_expressions` (mirror of the existing drop gate).
Corpus regression test: tests/codegen-bootstrap/match_arm_borrowed_field_return.yo
(corpus now 108/108 DIFF 0).

THIRD FAMILY FIXED (2026-07-10, same session) — STAGE-2 IS NOW CLEAN:
0 clang errors, DETERMINISTIC (two emits byte-identical). The residual
10 errors were short-circuit-branch RC temps (`(a || String.from(...))`,
`(a && xs.get(0))`) whose drops flushed OUTSIDE the branch's C scope. The
faithful mechanism already existed on both sides
(emitDropsForConditionalBranch scans pendingDeferredDrops, flushes
in-branch, records handled names) — but yo-self never fed the enclosing
scope's drops into `pending`:

1. `codegen/exprs/cond.yo`: the condition is a single-expr begin whose NODE
   the yo-self evaluator reuses (TS clones it into a begin node, so TS's
   begin codegen pushes its drops into pending on entry — begin.ts:47-49).
   Both condition-generation sites now wrap `_call_generate_expr(condition)`
   in the same pending window.
2. `codegen/functions/generation.yo`: the function BODY's scope-end drops
   now feed `pending` on entry (begin.ts:47-49 verbatim). The old "M1: do
   NOT feed" conservatism (early returns would drop not-yet-live locals) is
   superseded by the C-declaration-order gate in every drop emitter
   (declared_c_var_names + initialized_at_token resolution in
   return.yo's generate_pending_deferred_drops) — the emission-level
   equivalent of TS's init-position filter (begin.ts:2068-2122).

Corpus regression test: tests/codegen-bootstrap/short_circuit_rc_temp_drop.yo
(corpus 109/109 DIFF 0 after adding it; check ./yo-self 303/303; hashmap
reclaims; all repros byte-correct).

FOURTH ITEM FIXED (2026-07-10, same session) — the errno divergence, and
with it EVERY item from this investigation is resolved. The bug was not
constant folding: `get_variable_name_for_codegen` consulted the NAME-keyed
extern-C-globals registry, so IoError.from_errno's `errno : i32` PARAMETER
(shadowing <errno.h>'s `errno : *(int)`) kept the raw name `errno` — the
emitted comparisons read the C errno MACRO (thread-local, 0) instead of the
argument, mapping every code to Other ("unknown I/O error"). TS's rule is
per-RESOLVED-variable (`variable.type.isExtern === "c"` — extern-ness rides
the TYPE), so the faithful port keys the registry by declared TYPE:
`register_extern_c_global(name, ty)` (c_include.yo passes the field type)
and the codegen matches `type_key(registered) == type_key(resolved var)`.
(First attempt gated on is_module_level — wrong: c_include bindings are not
module-level-marked, which broke every `stdout`/`stderr` use; 39 corpus
SELF-FAILs, reverted for the type-match.)

Corpus regression test: tests/codegen-bootstrap/dyn_error_throw_ioerror.yo
(re-added; corpus 110/110 DIFF 0). Stage-2: 0 clang errors, deterministic.

RESOLVED-10 (was): 10 residual errors: scope-end drops (inline value-enum
`switch((temp).tag){…decr_rc…}`) referencing a temp DECLARED INSIDE a nested
`{ // begin block }` C scope but flushed at FUNCTION scope after the braces
closed. Root: yo-self declares evaluator temps at first use (inside the
nested block) while the drop was scheduled on an outer frame; TS declares
temps at the frame's own block level so its drops always see them. The
faithful fix is the temp-placement emission port (declare frame-level temps
at the frame's C block), NOT a declared-names bookkeeping patch. Locations:
grep the stage-2 clang log for "use of undeclared identifier" — 5 distinct
temps × decl-inside-block shapes.

ALSO DISCOVERED (separate, pre-existing): errno CONSTANT divergence — the
same `exn.throw(dyn(IoError.from_errno(i32(2))))` prints
"file or directory not found" under TS but "unknown I/O error" under the
self-compiled binary (the `i32(ENOENT)` comparisons in IoError.from_errno
resolve differently — likely c_include constant folding). Repro:
scratchpad ioerr_repro / the dyn_error_throw_ioerror.yo file removed from
the corpus to keep the gate green.

Original second-family analysis:
match-arm dup statements referencing
eval-time temp names that were never declared in C, e.g.

```c
case __YO_T138_SOME: {
  __yo_t139* e = tmp.data.Some.value;
  ((__yo_t6*)__yo_incr_rc((void*)(_file____User_temp_159360)));  // undeclared
  _file____User_temp_159363 = e->ty;                             // ← 3 ids later
```

The `___dup(<temp>)` expression embeds the temp variable name minted at ONE
evaluation of the arm body (`.Some(e) => e.ty` with e.ty RC-typed), but the
body was re-evaluated later (temp ids drift by ~3) and codegen materializes
the NEW temp while the deferred dup still names the OLD one. Same
side-table/id-churn family as the "durable macro-expansion" fixes. Entry
point: find where match-arm result dups are attached
(`set_expr_as_needs_to_call_dup` / `consume_case_body_temp_var` callers in
`evaluator/exprs/match.yo`) and why the arm body's second evaluation does not
refresh (or remove) the stale deferred dup.

Previously OPEN as: Introduced by the assert/panic refactor family (`7122740e9`..`4355dd1dd`);
NOT by the RC-protocol fix `97e51f176` (bisect: the binary built at `4355dd1dd`
emits the same errors — 417 vs 416, same class). The last clean stage-2
(0 errors, deterministic) was at the handoff `dddcbbbc5`. The true baseline is
unreproducible with the current toolchain (old yo-self sources call the old
builtin `panic`, which the renamed TS compiler no longer recognizes), so the
attribution is to the family as a unit.

## Symptom

```
./yo-cli compile yo-self/main.yo -o /tmp/s1                       # stage-1
YO_MAIN_STACK_MB=16384 /tmp/s1 compile yo-self/main.yo --emit-c --skip-c-compiler -o /tmp/stage2
clang -std=c11 -ferror-limit=0 -c /tmp/stage2.c -o /dev/null -I.
# 416 errors (was 0 at dddcbbbc5)
```

Error families (all cascade from ONE missing type):

- `unknown type name '__yo_t782'` — the typedef for t782 is nowhere in the
  file, while forward decls / signatures / a dyn box reference it.
- `use of undeclared identifier '__yo_dyn_box___yo_t782'` — its dyn(Error)
  box struct is used (`__yo_new___yo_dyn_box___yo_t782`,
  `__yo_dispose___yo_dyn_box___yo_t782`) but the box struct was not declared.
- `use of undeclared identifier '_file____User_temp_5487'` (34×, plus
  singletons) — `__yo_t782 _file____User_temp_5487;` declarations in other
  functions were elided (declaration emission presumably failed on the
  unregistered type) while the temps' uses survived.

## What t782 is

An errno-mapping ERROR ENUM: `yo_id_6236(int32_t __yo_c_reserved_errno) ->
__yo_t782` with variants like `__YO_T782_NOTFOUND` (`(errno) == (ENOENT)`
mapping), and it gets dyn-boxed (`dyn(Error)`), i.e. the std/sys or std/fs
errno→Error conversion enum. The stage-2 emit's type-collection pass misses
it; everything referencing it then breaks.

## Suspected mechanism

The assert/panic refactor changed how error paths evaluate:

- `__yo_panic` value-position arms now adopt the sibling arm's expected type
  (evaluate_panic), and std/assert's `panic` pulls `ToString`/`to_c_str`/dyn
  machinery into scope in 20+ yo-self modules;
- the errno enum's instantiation may now be minted via a path whose type id /
  type_key never reaches `collect_type` (the classic collected-vs-referenced
  identity mismatch — same family as the stage-2 endgame's
  resolved_concrete/type_key bugs).

## Repro / debug entry

1. Emit stage-2 (commands above); grep `__yo_t782` — first use at a fn
   signature (`yo_id_6236`), no typedef anywhere.
2. Find the Yo-source enum: grep std for the ENOENT→NotFound mapping
   (`errno`-to-error fn). Trace why `collect_type` never sees the enum's
   type id while `get_type_string` had a registered C name for it
   (two tables: `get_type_c_name` HAS it, the emitted-typedef set does NOT —
   the c-name was minted during function emission AFTER the types section
   was finalized).
3. Candidate fix direction: any `get_type_string` minting during
   function-body emission must either be preceded by collection
   (collect_type at the same site) or the types section must be emitted
   LAST (TS emits type decls from the collected set before functions —
   check where the yo-self pipeline diverges for this enum).

## Validation gates once fixed

- stage-2 clang errors 0, deterministic (emit twice, byte-identical);
- corpus diff-test 107/107 DIFF 0;
- `check ./std` 153/153, `check ./yo-self` 303/303;
- then resume the handoff plan (stage-2 binary runtime → fixpoint → #69/#70).
