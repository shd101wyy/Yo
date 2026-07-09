# yo-self stage-2 fixpoint — HANDOFF PLAN (remaining work)

**Goal:** drive the yo-self self-compile ("stage-2") clang errors to **0**, then make
the self-compiled `yo-self` binary's `test` subcommand pass `./tests` and
`./yo-self/tests` (tasks #69, #70).

**Current state: 1 deterministic stage-2 error + 1 FLAKY family** (was 56).
Deterministic: undeclared RC-drop temp `_file____User_temp_1886xx` (1 error — scope-end
drop of a never-materialized temp at a loop tail).
FLAKY (nondeterministic per emit, ~8-10 errors when it appears): GC-tracer `.label`/`.ty`
member-refs on `__yo_tNNN *` — the tracer body specialized for Bucket(String, FuncParam-like)
bound to a different Bucket instantiation's slot type (order-dependent struct identity).
FIXED this session: member-ref (\*self) family, io.async closure FTT, argv-index if-arm FTT,
undeclared get_info (closure-param capture), capture-in-capture emission order, box-of-closure
collection. **Compare stage-2 runs by error TEXT and re-run before attributing new errors.**

### Next step for the RC-temp (the 1 deterministic error)

`__yo_decr_rc((void*)(_file____User_temp_1886xx))` at a loop tail in the
await-analysis per-point loop (yo*id_252975-family fn); the temp has exactly ONE
occurrence (never declared). The scope-end skip gate EXISTS
(codegen/exprs/drop_dup.yo:567: `is_temp_variable_name(ei.env.module_path, cn)
&& !declared_c_var_names.contains(cn)`) but this instance evades it — suspected
PREFIX MISMATCH: the temp was minted under a different module_path (URL-form
`file:///Users/...` → prefix `_file____User...`) than the drop site's
`ei.env.module_path`, so `is_temp_variable_name` returns false and the gate
never fires. PROBE: at drop_dup.yo:567, when `cn.contains("\_temp*")`and the
module check is false, eprintln module_path + cn; run stage-2; then either fix
the minting module_path or relax the gate to any`contains("_temp_")` name
not in declared_c_var_names (TS has NO such gate at all — the whole skip is a
yo-self-only compensation, so the relaxed form is safe by the same argument
as the original: a never-declared C var cannot double-free or leak).

### The FLAKY tracer cluster (root direction)

Tracer fn `yo_id_12__struct_struct_yo_id_NNN...` body specialized for
`Bucket(String, FuncParam-like)` (walks `.value.label`/`.value.ty`) but bound
to a DIFFERENT Bucket instantiation's slot type (e.g. value = `_SlotRange*` or
`size_t`). [TRACE-SPEC] probe (collection.yo \_specialize_and_register_trace)
showed 1:1 ct→fid on a clean run — the collision is elsewhere (suspect
get_trace_function_for_type lookup or the traversal generator's Bucket-slot
type resolution). Appears in roughly half of emits; compare by error text.

---

## 0. Ground rules (READ FIRST)

**Faithful-port discipline (non-negotiable):** For every bug — (1) confirm the
TypeScript compiler (`./yo-cli`) emits CLEAN C from the same input; (2) find the
yo-self DIVERGENCE from `src/`; (3) fix yo-self to match `src/`. If TS is also
wrong, fix TS first, then port. NO workarounds, NO stubs. `yo-self/` must stay a
1-to-1 port of `src/`.

**Editing `.yo` files does NOT need `bun run build`** (that only rebuilds the TS
compiler). Just re-run `./yo-cli compile yo-self/main.yo`.

**RC-safety:** the drop/dup families are RC-critical. A wrong drop point =
double-free or leak. The corpus diff-test is the double-free ORACLE (see §1).

---

## 1. The iteration loop + validation protocol (used EVERY phase)

```bash
# 1. Build the yo-self binary from current yo-self/ source (~5 min).
./yo-cli compile yo-self/main.yo -o /tmp/yo-self-bin &> /tmp/build.txt
grep -iE "Error:" /tmp/build.txt | tail   # must be empty; binary must exist

# 2. Emit stage-2 C (yo-self-bin compiling yo-self) (~1 min).
/tmp/yo-self-bin compile yo-self/main.yo --emit-c --skip-c-compiler -o /tmp/stage2 > /tmp/s2emit.txt 2>&1

# 3. TRUE error count — MUST use -ferror-limit=0 (clang's default 20 hides 2/3!).
clang -std=c11 -ferror-limit=0 -c /tmp/stage2.c -o /dev/null -I. 2>/tmp/s2.txt
grep -c "error:" /tmp/s2.txt                                  # the metric
grep "error:" /tmp/s2.txt | sed -E 's/.*error: //; s/'"'"'[^'"'"']*'"'"'/X/g; s/[0-9]+/N/g' | sort | uniq -c | sort -rn  # distribution
```

**Validation gates (run after EVERY code change, before committing):**

```bash
# Corpus diff-test — RC double-free ORACLE + TS-parity. MUST stay 103/103, DIFF 0.
YO_SELF_BIN=/tmp/yo-self-bin bash scripts/diff-test.sh tests/codegen-bootstrap/ --parallel 4
# std eval check — MUST stay 152/152.
/tmp/yo-self-bin check ./std
```

**If corpus DIFF > 0 or SELF-FAIL > 0, or std < 152 → REVERT immediately.** These
are non-negotiable. Only commit when: stage-2 count dropped, corpus 103/103 DIFF 0,
std 152/152.

**Minimal-repro workflow** (isolate a bug from the 56):

```bash
# Extract the failing construct into a tiny standalone .yo with main + export(main).
/tmp/yo-self-bin compile /tmp/repro.yo --emit-c --skip-c-compiler -o /tmp/r > /tmp/re.txt 2>&1
clang -std=c11 -ferror-limit=0 -c /tmp/r.c -o /dev/null -I. 2>&1 | grep "error:"
# ALWAYS also run the SAME repro through TS and confirm 0 errors:
./yo-cli compile /tmp/repro.yo --emit-c --skip-c-compiler -o /tmp/rts > /tmp/rtse.txt 2>&1
clang -std=c11 -ferror-limit=0 -c /tmp/rts.c -o /dev/null -I. 2>&1 | grep -c "error:"   # expect 0
```

**Probe/instrumentation technique** (proven this session — how to trace evaluator/
codegen decisions without a debugger):

- Add a module-level helper `_dbg :: (fn(cond : bool, tag : str) -> unit)(if(cond, eprintln(tag), ()));`
  (import `{ eprintln } :: import("std/fmt");`). **`str` implements `ToString`, so
  `eprintln(str)` needs no owned `String` temp** — this dodges the begin.yo
  "Frame level N has different number of values" frame-merge error that bites any
  probe creating an owned temp inside an unbalanced `if`-block.
- Guard with a distinctive constant (e.g. a specific func_id / var name) so output
  isn't drowned; grep + `sort | uniq -c`.
- To correlate a codegen emission with its SOURCE PATH, inject a distinctive C
  COMMENT (`em.emit_string_line(\`${indent}// [TAG]\`)`) and grep the emitted C —
  position-correlated, unlike eprintln.
- ALWAYS `git checkout <file>` to revert probes before building the real fix / committing.

---

## Progress log

| Session    | Change                                                   | Δ            |
| ---------- | -------------------------------------------------------- | ------------ |
| Prior      | per-closure async result-type fix (`a675f54eb`)          | 56→44 (-12)  |
| 2026-07-06 | unwind double-return fix (`d0518c359`)                   | 44→42 (-2)   |
| 2026-07-06 | recur ref-param deref strip (`dd4473afc`)                | 42→39 (-3)   |
| 2026-07-07 | match arm frame-pop cleanup (`fabb2d9dd`)                | 39→35 (-4)   |
| 2026-07-08 | explicit (!=) in Eq(str)/Eq(String) (`9d2eb7d48`)        | 35→33 (-2\*) |
| 2026-07-08 | fieldless while-pop + loop scope markers (`395537d77`)   | 33→27 (-6)   |
| 2026-07-08 | `_was_self_bound` top-down search (`8b3a1ceed`)          | neutral      |
| 2026-07-08 | env→global-table SomeType registration (`48490fefb`)     | neutral      |
| 2026-07-08 | substituteSomeTypesFromEnv faithful port (`dcc441baf`)   | neutral      |
| 2026-07-08 | IoExn gating in `_resolve_some_types_deep` (`921bf3aea`) | neutral      |
| 2026-07-09 | intern-key SomeT full-content fix (statx cluster ROOT)   | 27→20 (-7)   |

---

## Remaining error breakdown (18 total as of 2026-07-09)

| Count | Category               | Details                                                                                                                                                                                                                                                                               |
| ----- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4     | expected expression    | 2x dyn() "missing trait values", 2x "Failed to transpile" leftovers                                                                                                                                                                                                                   |
| 3     | member ref base type   | ONE shared GC tracer (`yo_id_12__struct_yo_id_13636`) reused across ALL Bucket instantiations; body traces Option-key, slot decl is Bucket(usize,\_) — trace-specialization not per-instantiation. (Was the old 5x passing-incompatible family — same root, different manifestation.) |
| 2     | incomplete type void   | Empty capture struct -> `(void){}` — capture VALUE gen path                                                                                                                                                                                                                           |
| 2     | undeclared identifiers | `get_info` (closure capture), 1 temp (branch leak)                                                                                                                                                                                                                                    |
| 2     | operand arithmetic     | Dyn dispatch not lowered to vtable calls                                                                                                                                                                                                                                              |
| 2     | assigning from void\*  | `__yo_t414` from void\* — cascade from await codegen                                                                                                                                                                                                                                  |
| 2     | ptr-to-int             | void\* -> int32/`__yo_t28`                                                                                                                                                                                                                                                            |
| 1     | member ref not pointer | ref-struct member access                                                                                                                                                                                                                                                              |

----- | ---------------------- | --------------------------------------------------------------------------------------------- |
| 5 | passing incompatible | `__yo_t628/630` → `__yo_t114`: type identity, self-compiler re-registers types (Phase 4) |
| 4 | expected expression | 2× dyn() "missing trait values" (136218), 2× "Failed to transpile" leftovers (232195, 233916) |
| 2 | incomplete type void | Empty capture struct → `(void){}` — capture VALUE gen path, not struct decl (Phase 4) |
| 2 | undeclared identifiers | `get_info` (closure capture, 248170), 1 temp (branch leak, 136267) |
| 2 | assigning from void\* | `__yo_t414` from void\* (147362, 184218) — cascade from await codegen (Phase 4) |
| 2 | operand arithmetic | Dyn dispatch not lowered to vtable calls (232751-2, Phase 4) |
| 2 | ptr-to-int | void\* → int32/`__yo_t28` (84999, 103964) |
| 1 | member ref not pointer | `__yo_t380` not a pointer (215588) |

---

## PRIMARY NEXT STEP — SomeT `resolved_concrete_type` per-object field (unblocks 7+ errors)

After 5 fix rounds on Dyn(Fn) and 2 on the Bucket tracer (2026-07-09, all
recorded in issues/), every remaining hard family converges on ONE structural
divergence: yo-self keys type resolutions by SHARED/CLONED SomeT ids
(g_some_resolved_concrete global) where TS carries them on the type OBJECT
(`SomeType.resolvedConcreteType`, definitions.ts:191). Clones/interning/
re-instantiation re-mint ids, so id-keyed resolutions miss or collide.

The refactor (spec in issues/yo-self-dyn-fn-field.md "CONVERGED DIAGNOSIS"):
add `resolved_concrete_type` to SomeT (definitions.yo:249), exclude it from
type_key / type_intern_key / compatibility identity, convert the
register/lookup_some_resolved_concrete write+read sites to prefer the field
(global as fallback during transition). This dissolves the Dyn(Fn) box-payload
bridge, the Bucket-tracer receiver identity, and retires the IoExn gating
hacks (evaluator/types/function.yo:3926-64). Gates after each step: corpus
103/103 DIFF 0, std 152/152, stage-2 count (baseline 18).

---

## Shared-GC-tracer family (3 errors) — ROOT KNOWN, fix requires re-instantiation

**Root (probe-confirmed 2026-07-09):** ONE Bucket `trace` specialization serves ALL
Bucket instantiations. During EACH HashMap-trace body re-eval, the inner
`bucket.trace(tracer)` call's receiver arg*type is the SHARED GENERIC
`Bucket(K, V)` TypeValue object (one id), so
`compute_compile_time_signature` renders the IDENTICAL degenerate sig
(`...\_struct_struct_yo_id_NNNN*...`) for every instantiation — the
specialization cache/func-id collide and the first Bucket tracer body is
called with every Bucket layout (member-ref errors when layouts differ, silent
wrong-offset tracing when they don't). Minimal repro:
`scratchpad/repro_tracer2.yo`— two HashMaps (String/usize keys) with a cyclic
ref-struct value; the collision shows as 3 incompatible-pointer WARNINGS + one
shared`yo_id_12\_\_...` tracer in the emitted C.

**Two fixes attempted and REVERTED (both INERT):** resolving the sig's
runtime-param types via `evaluate_function_parameter_type_again` against (a)
callee_env and (b) caller_env — substitution DOES NOT RECURSE into nominal
struct types (by design, both compilers), so the generic Bucket passes through
unchanged. Concretizing `Bucket(K, V)` → `Bucket(String, Node)` requires
RE-INSTANTIATION (a comptime-fn call with the bound K/V), i.e. the
"generic-instantiation type-identity consistency" critical path (same blocker
as the module-var port). TS cannot collide here: per-instantiation
FunctionValue OBJECTS carry their own `specializedFunctionCaches`.

**Probe kit (rebuild with these when resuming):** `[SPEC-MISS/HIT]` at
create_specialized_function_inline's cache lookup (guard: any runtime param
whose `type_key` contains `"<struct:"` — the degenerate-rendering marker) +
`[TRSPEC] ctkey/fid` in `_specialize_and_register_trace`
(codegen/functions/collection.yo).

**Also noted:** `type_key` has NO Pointer arm — `*(T)` falls to the
`type_to_string` catch-all (type*key.yo:270). Aligning pointers with
`*<child-key>\_ptr` would make pointer keys consistent, but is NOT sufficient
for this family (the receiver OBJECT itself is shared/generic).

**Candidate directions:** (1) re-instantiate the receiver's generic
instantiation at the inner-call site when its type_arguments/SomeT fields are
resolvable from the env (drive the comptime-fn cache — gives stable
per-instantiation identity for free); (2) port TS's FuncVal-attached
per-instantiation specialization caches.

---

## Phase 2 — expected expression statx cluster — RESOLVED (2026-07-09)

**Fixed by ONE surgical change**: `yo-self/types/intern.yo` — `type_intern_key`'s
`SomeT` arm rendered `So:<id>` ONLY. Now renders the full distinguishing content
(name, frame_level, parent_type, required/negative trait types + levels,
is_effects_row, kind_function_type), visited-guarded like the TraitT/EnumT arms.

### TRUE root cause (supersedes ALL prior Phase-2 theories)

`substitute()` (types/substitution.yo:100) wraps every result in `intern_type`
(P2 hash-consing). The intern key for `SomeT` was **id-only**. The shared
`Impl(Fn(e : E) -> T)` io.async action wrapper keeps ONE SomeT id across all
call sites, but substitution produces per-call variants whose
`required_trait_types` differ (`Fn(e : IoExn) -> i32` for a command.yo call vs
`Fn(e : Io) -> bool` for `fs.exists`). The id-only key canonicalized every
later call's substituted wrapper back to the FIRST interned variant — so
`exists`/`is_file`/`is_dir` closures got param `e : IoExn` (no `.await` field),
`io.await` collapsed to unit, and codegen emitted `(() < ())` / `return (() >= ())`.

This is the same wrong-merge class as the 2026-07-02 EnumT id-only bug the
intern.yo header warns about — SomeT was simply never given the full-content
treatment.

**Both earlier theories were WRONG**: (a) global-table `lookup_some_resolved_concrete`
poisoning — probes showed ZERO Io/IoExn registrations for the repro; (b) the
env `_do_chain_resolve` ownership gate — the gate does reject the correct
binding, but the poisoned type never came from that path.

### How it was found (reusable methodology)

1. **Minimal repro** (seconds per iteration instead of 6-min stage-2 emits):
   a tiny `main` importing `std/fs/file` + calling `exists` reproduced the 2
   errors. Shrinking further showed the trigger was `IO_file.statx` (via
   `std/sys/constants` → `std/process` → `command.yo`'s 4 IoExn io.async calls
   evaluated FIRST at module load).
2. **Targeted eprintln probes** (one rebuild): `[EBIND]` showed the E-binding
   computes the CORRECT effect per call (4× IoExn + 1× Io); `[REG]/[LOOK]`
   showed the global table was NEVER involved; `[SUBP]` showed the closure
   param-type substitution ran only ONCE (first closure) — every later closure
   received an **already-concrete IoExn** param type → the shared expected-type
   object itself was poisoned → led straight to `substitute`'s interning.
3. TS reference: TS has NO interning (fresh objects per substitution;
   per-object `resolvedConcreteType`), so object identity is per-call there.
   The intern key MUST be at-least-as-fine as any eval-level distinction, not
   just codegen identity.

### Validation

- repro compiles clean AND runs correctly (`true`, matches TS output)
- corpus 103/103 DIFF 0, std check 152/152
- stage-2: 27 → 20 (−7: 6 statx expected-expression + 1 conflicting-types)

### Cleanup opportunity (follow-up)

The four "neutral" commits from 2026-07-08 (`8b3a1ceed`, `48490fefb`,
`dcc441baf`, `921bf3aea`) added IoExn-specific gates/registrations that were
aimed at the WRONG root. They validated green but are now candidates for
re-audit: the `_skip_fallback` for "E" and the IoExn-registration skip in
`evaluator/types/function.yo:3926-3964` are non-faithful (TS has no such
special cases) and may be removable now that interning no longer wrong-merges.
Re-run the gates after any removal.

## Phase 1 — leaked-locals + undeclared identifiers (2 errors remaining)

### Remaining errors

| Error                                    | Count | Root cause                                                                                                                            |
| ---------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `get_info` (undeclared)                  | 1     | Closure capture not routed through capture struct — atom codegen emits bare identifier instead of `((cap*)closure_context)->get_info` |
| `_file____User_temp_188XXX` (undeclared) | 1     | While-body deferred-drop scope leak — temp declared inside loop body `{ }` scope, drop emitted after scope closes                     |

### `get_info` investigation

`get_info` is a parameter of type `Impl(Fn(e: AstExpr) -> Option(ExprInfo))` in
`analyze_await_points` (`await_analysis.yo`). It's created as a closure at
`anonymous_function.yo:1075`: `(e : AstExpr) => expr_info_table_get(info_tbl, e)`.

The C code shows `closure_yo_id_277784(void* closure_context, ...)` using
`get_info` directly (not via `closure_context->get_info`). The capture struct
`__yo_t823` only has `await_extras` — `get_info` is missing.

**Investigations (2026-07-08):**

- Probes confirmed `get_info` IS tracked by `track_variable_usage` and IS in
  `enrich_captured_variables` output (first eval). But subsequent evals
  produce different cap_keys (fewer fields) → different struct_ids.
- `register_closure_capture_info` gate (`is_none()` check) attempted — neutral,
  didn't fix the issue. The first eval might also be missing `get_info` in
  the capture struct for reasons unrelated to overwrite.
- `register_struct_fields` gate (same pattern) attempted — neutral.
- `_is_some_type_codegen_concrete` in collection.yo attempted — +3 new errors
  (see REVERTED above). The `Impl(Fn)` type should be treated as concrete
  for codegen purposes (faithful to TS `typeContainsSomeType`), but making
  this change causes more structs to be emitted with type mismatches.

**TS faithful note**: TS's `typeContainsSomeType` (utils.ts:507-521) explicitly
treats `Impl(Fn)` and `Impl(Future)` as concrete at codegen time (`return false`).
yo-self's `type_contains_some_type` (utils.yo:838) does not have this gate. This
is a port gap that needs to be fixed for `get_info` to work — the capture struct
with `Impl(Fn)` fields must be emittable. But fixing this requires also handling
the type identity cascades.

### Temp variable scope leak

The undeclared temp `_file____User_temp_188329` is a while-body local whose
deferred drop is emitted AFTER the loop body's `{ }` scope closes. Same class
of bug as the earlier fieldless-arm while-loop frame pop (fixed by `395537d77`).
Likely fix: ensure the while evaluator pops the loop-body frame from the body's
ExprInfo.env before storing it.

---

## Phase 3 — str→String overload (RESOLVED)

`commit 9d2eb7d48` — explicit `(!=)` methods in `Eq(str)` and `Eq(String)` impls
in `std/string/string.yo` using infix `==` operator. Net: fixed the str→String
error. Remaining overload issues for `Self.(==)` are separate.

---

## Phase 4 — type-identity + syntax cascade (remaining ~12: incompat 5, incomplete-void 2, member-ref 1, operand-arithmetic 2, etc.)

**This is the deepest family** — do it LAST. Some of it likely CLEARS once Phase
2 lands (the "expected expression" 10 + "assigning from void\*" 2 are SYNTAX
CASCADES downstream of the broken io.await codegen).

**Errors:** `passing incompatible type` ×5 (type identity: self-compiler re-registers
the same type with different IDs), `incomplete type void` ×2 (empty capture struct),
`member reference on size_t` ×3 (random, varies per compilation), `operand arithmetic`
×2 (dyn dispatch not lowered), `member ref not pointer` ×1 (`(*self)->_fd`),
`ptr-to-int` ×2 (cascade), `conflicting types` ×1 (async closure proto vs def).

### Landed: Phase 4 match-arm frame-pop cleanup (−4)

`commit fabb2d9dd` — `yo-self/evaluator/exprs/match.yo`
Faithful port of TS `match.ts:485-493`. The yo-self match evaluator pushed
`match_arm_frame` per arm, evaluated the body, then popped from the LIVE env only.
The body's `ExprInfo.env` (a snapshot created inside `new_expr_info`) still carried
`match_arm_frame`. This leaked frame was later ingested via
`env.frames = bi.env.frames` (match.yo:2249), redirecting variable additions to the
wrong frame and misdirecting begin-block scope-end pop operations.

Fix: after `env.pop_frame()` in all 4 arm branches (fieldless, wildcard/comptime,
literal, with-fields), also pop from `body_info.env` via `pop_env_frame`.

Net: undeclared identifiers 13→4 (−9), total 39→35 (−4). Corpus 103/103 DIFF 0.

### Landed: Phase 1 while-body frame-pop + C scope markers (−6)

`commit 395537d77` — `yo-self/evaluator/exprs/match.yo` + `yo-self/codegen/exprs/while_loop.yo`

**match.yo fix**: The fieldless arm (`_ => body`) used a single `env.pop_frame()`,
which pops the wrong frame when a leaked frame is present. Changed to while-loop
pop `while(env.frames.len() > base_frame_count_fl)`.

**while_loop.yo fix**: Added C scope markers `{ // begin block (loop body)` and `}`.

Net: undeclared 5→2 (−3), total 33→27 (−6).

### Landed: Phase 4 per-closure async result-type fix (−12)

`commit a675f54eb` — `yo-self/codegen/exprs/async.yo`
Root cause: Multiple closures implementing the same `Future(T)` trait share
a single `lookup_some_resolved_concrete` key (the SomeType id). The first
closure's registration poisons all subsequent closures' struct result types.
Fix: composite key `output_some_id@@async_block_id` — unique per closure.

### REVERTED: match arm classification fix (2026-07-08)

Attempted to re-classify `.Some(v) => body` from fieldless to with-fields.
Caused 101 SELF-FAIL. Classification is correct as-is. DO NOT RETRY.

### REVERTED: empty struct `_dummy` field (2026-07-08)

Attempted to add `uint8_t _dummy` to zero-field struct declarations. Inert.
The `(void){}` comes from capture struct VALUE gen, not struct decl. DO NOT RETRY.

### REVERTED: while loop body deferred drops in non-begin branch (2026-07-08)

Attempted to add deferred drop emission in `generate_loop_body`'s non-begin
branch. Inert — drops not on that expr. DO NOT RETRY.

### REVERTED: env_lookup.yo `_def_frame_confirms_binding` replacement (2026-07-07)

Replaced the def-frame gate with full-env search. Result: 31→144 errors, 12 SELF-FAIL.
The gate exists to prevent false matches. DO NOT RETRY.

### Landed: earlier fixes

- `commit 7a247c538` — `_chain_resolve` fast-path falls through on self-bound marker
- `commit 7c4191da8` — io.await/state/spawn args skip expected-type
- `commit dd4473afc` — recur ref-param deref strip
- `commit d0518c359` — unwind double-return elimination

### Member-ref-not-pointer investigation (older)

`(*self)->_fd` where `self` is a `ref` struct. The atom codegen wraps `(*self)`
for `is_ref` variables. Attempted to strip `(*)` or use `.` — both 82 errors.

**Faithful-port fix:** TS atom codegen does NOT wrap `(*self)` for ref struct
variables — it only does so for `isRef` (`inout`) params. Check if yo-self
incorrectly sets `is_ref` for ref struct self-params.

---

## Phase 5 — Definition of done + `test` subcommand (tasks #69, #70)

Once stage-2 clang errors = 0:

1. Full stage-2 compile to a binary + run it:
   `/tmp/yo-self-bin compile yo-self/main.yo -o /tmp/stage2-bin && /tmp/stage2-bin --version`
   (or a trivial compile) — confirm the self-compiled binary WORKS, not just compiles.
2. **Task #69:** `/tmp/stage2-bin test ./tests --parallel 8` should pass what
   `./yo-cli test ./tests` passes.
3. **Task #70:** `/tmp/stage2-bin test ./yo-self/tests` likewise (note: eval trio +
   heavy files — see yo-self/README.md; the full dir is ~90 min).
4. Fixpoint: stage-2 binary compiling yo-self should itself produce a stage-3 that
   is byte-identical (or diff-clean) to stage-2.

---

## Key code locations (quick reference)

| File                                             | Lines     | Purpose                                                                   |
| ------------------------------------------------ | --------- | ------------------------------------------------------------------------- |
| `yo-self/evaluator/calls/function.yo`            | 3299-3353 | io.async/io.await type refinement                                         |
| `yo-self/codegen/exprs/await.yo`                 | 362-551   | `generate_await` — sync-future io.await codegen                           |
| `yo-self/evaluator/calls/helper.yo`              | 2432-2535 | Synthesis: forall binding in callee_env                                   |
| `yo-self/evaluator/calls/helper.yo`              | 2608-2661 | E-binding: E=Io/IoExn in callee_env                                       |
| `yo-self/evaluator/values/anonymous_function.yo` | 452-467   | `expected_type_env` extraction                                            |
| `yo-self/evaluator/values/anonymous_function.yo` | 748-785   | `substituteSomeTypesFromEnv` — param type resolution                      |
| `yo-self/evaluator/values/anonymous_function.yo` | 1075      | `get_info` closure creation for await_analysis                            |
| `yo-self/evaluator/types/function.yo`            | 3891-3998 | `_resolve_some_types_deep`                                                |
| `yo-self/expr_info.yo`                           | 544-551   | Global table: `register_some_resolved_concrete`                           |
| `yo-self/types/utils.yo`                         | 838-844   | `type_contains_some_type` — shallow, no Fn/Future gating                  |
| `yo-self/evaluator/trait_checking.yo`            | 1265-1323 | `type_contains_some_type_for_codegen_param` — deep, with Fn/Future gating |
| `yo-self/codegen/types/collection.yo`            | 84-116    | `_struct_some_type_is_only_in_function_fields`                            |
| `yo-self/codegen/exprs/atom.yo`                  | 247-313   | Closure-captured atom emission                                            |
| `yo-self/evaluator/utils/closure.yo`             | 207-301   | `create_capture_type_and_value`                                           |
| `yo-self/function_value.yo`                      | 84-89     | `register_closure_capture_info` (overwrites)                              |
| `yo-self/evaluator/types/field.yo`               | 80-82     | `register_struct_fields` (overwrites)                                     |

---

## Quick reference — commit conventions

- Commit only validated changes (stage-2 down + corpus 103/103 DIFF 0 + std 152/152).
- End commit messages with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Run `./yo-cli fmt <file.yo>` on every `.yo` you touch before committing.
- Put new bug analyses in `issues/`, plan updates in `plans/`.
