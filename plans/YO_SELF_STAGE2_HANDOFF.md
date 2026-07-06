# yo-self stage-2 fixpoint — HANDOFF PLAN (remaining work)

**Goal:** drive the yo-self self-compile ("stage-2") clang errors to **0**, then make
the self-compiled `yo-self` binary's `test` subcommand pass `./tests` and
`./yo-self/tests` (tasks #69, #70).

**Current state @ commit `099e9ca9c`: 56 stage-2 clang errors** (was 60; this
session fixed the String==str family, `d72e5080d`, and pinned leaked-locals).

This doc is the actionable plan. Deep per-family analysis lives in:

- `plans/YO_SELF_STAGE2_FIXPOINT_ROADMAP.md` — full history + type-identity analysis.
- `issues/yo-self-stage2-leaked-locals-loop-body.md` — leaked-locals (fully pinned).
- `issues/yo-self-stage2-string-ne-str-specialization.md` — String==str (fixed + residual).

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
- To isolate one function among many with a common local name, use a co-variable
  check (`_frame_has(frame, "i")`).
- ALWAYS `git checkout <file>` to revert probes before building the real fix / committing.

---

## Phase 1 — leaked-locals (13 errors, FULLY PINNED, do this FIRST)

**Why first:** largest single family, completely root-caused (3 passes this
session), self-contained. Errors: `t`×2, `t_expr`, `get_info`, `frame`, `arg_expr`
(5 user vars) + 7 `_file____User_temp_*` (temps) — all "use of undeclared identifier".

**Root (see issue file for the full pin):** a loop-body owning local — e.g.
`t := match(required_trait_types.get(i), .Some(v)=>v, .None=>{i+=1; continue})` in
`extract_future_trait_from_type` (trait*checking.yo:1397) — is C-declared INSIDE
the `while {}` but its RC-drop is emitted at the ENCLOSING match-arm scope-end
(after the loop label, out of C block scope). CONFIRMED emitter (via injected
`// [SED-SCOPE-END]` tag): `generate_deferred_drop_expressions` (drop_dup.yo:542)
draining the ARM begin block's `deferred_drop_expressions` → so `t` (a while-body
local) is in the ARM frame's scope-end drops. **TS drops loop-body locals INSIDE
the loop, per-iteration** (verified in /tmp/yo-self-9.c ~149060,
`fn*...\_id_43\_\_\_drop(t)`after`i++`, before `}`).

**Two fix routes — do (A) first, it's correct + matches TS:**

### Route A (EVALUATOR — correct, drops `t` inside the loop like TS)

1. **Find which frame `t := match(...)` binds into.** Instrument `add_variable_to_env`
   (env.yo) OR `_schedule_scope_end_drops` (begin.yo:227) to print, for var name
   `"t"`, the frame level / whether `ctx.is_evaluating_loop_body` is set. Expected
   finding to confirm: `t` ends up in the ARM frame (co-var probe already showed
   `t`+`i` in one non-loop frame — a leak from the while-body frame up to the arm).
2. **Locate the leak in `evaluate_while` (while.yo:305-540).** The body is evaluated
   via `evaluate_begin_expression(body_expr, env, ...)` at line 310, which pushes a
   frame. After the body eval + control-flow handling, the outer `env.frames` /
   `out_info.env` must NOT carry the while-body frame's vars up to the arm. Check
   lines 347/354/366/470/490 (`env.frames = body_info.env.frames`) — one of these
   propagates the body frame. Compare against TS `evaluateWhile` in
   `src/evaluator/exprs/while.ts` for the exact env-threading (yo-self must match).
3. **Fix so `t` stays a while-body local** → the while-body begin block's
   `_schedule_scope_end_drops` schedules its drop → `generate_loop_body`
   (while_loop.yo:146-169) emits it INSIDE the loop. Note: the while-body begin
   block does NOT skip on control flow here — the skip (begin.yo:250-268) only
   checks DIRECT statements, and extract_future's return/continue are NESTED in
   matches, so the body reaches the var loop normally.
4. **Coordinate with control-flow exits** so nothing double-drops: `t` is moved on
   the `return .Some(t)` path (consumed, `consumed_at_token` set → e5 excludes it)
   and not-yet-bound on the `continue` path — so only the fall-through iteration
   end should drop it. Verify the continue/break path
   (`_emit_loop_body_drops_before_exit`, atom.yo:32) and the fall-through drop are
   mutually exclusive per-var (TS is the reference).

### Route B (CODEGEN — pragmatic fallback if A proves too deep; LEAKS `t`, diverges from TS)

- Make drop emission scope-EXIT aware. `declared_c_var_names` (codegen context) is
  FUNCTION-scoped (grown-only, never removed on block exit), so it can't tell that
  `t` (declared inside the now-closed loop `{}`) is out of scope. Snapshot
  `declared_c_var_names` on loop-body entry in `generate_while_loop`
  (while_loop.yo:186), compute the vars declared INSIDE the loop, and in
  `generate_deferred_drop_expressions` (drop_dup.yo:542) skip a drop whose target
  is a loop-only var (extend the existing `undeclared_temp` skip — currently
  temps-only — to these). Safe (no double-free) but leaks `t`. Only if A is blocked.

**Validate:** stage-2 (expect −8 to −13; the 7 temps likely clear too), corpus
103/103 DIFF 0, std 152/152, + an ASan run on a corpus binary
(`./yo-cli compile <corpus>.yo --release --sanitize address --allocator libc -o t && ./t`).

---

## Phase 2 — async state-machine struct return type (~2-4 errors)

**Errors:** `conflicting types for 'closure_yo_id_6942'` (proto emitted `void*`,
definition `__yo_t413*`) + `member reference type '__yo_t405' is not a pointer`
(a state-machine access `sm->field` on a value/void\*) + likely some of the
incompat/int-conv in Phase 4.

**Root (see roadmap "MEMBER-REF" entries):** an async fn / closure returns `void*`
instead of its concrete Future state-machine (SM) struct, because the SM struct is
registered under the io.async BLOCK's future SomeT id, not the FUNCTION-return
SomeT id, so `get_type_string(future_type)` → `void*`. The forward declaration and
the definition then disagree (`void*` vs `__yo_t413*`) = conflicting types.

**Steps:**

1. Minimal repro: a fn returning a Future (an `io.async` closure whose result is
   awaited), self-compiled. Confirm TS emits it clean.
2. Compare the async SM-struct type registration in yo-self
   `src/codegen/exprs/async.yo` (search `register_some_resolved_concrete`,
   `type_key(future...)`, SM-struct emission ~2064) vs TS `src/codegen/exprs/async.ts`.
   Ensure the SM struct is registered under the async FUNCTION's return-type SomeT
   id (and/or the forward-decl uses the same resolved return type as the definition).
3. The forward declaration (declarations.yo `generate_function_prototype` +
   `compute_async_return_override` ~490) and `generate_function` must compute the
   SAME override return type. Verify `find_returned_async_block` resolves the SM
   struct at BOTH sites.

**Validate** as §1. Phase-5 async feature area; check the roadmap's async notes.

---

## Phase 3 — String==str residual: inner `Self.(==)` overload (~1-3 errors)

**Errors:** some of the "passing '**yo_t433' ... incompatible type '**yo_t433 \*';
take the address with &" and/or "passing incompatible type" — the specialized
`!=` body's `Self.(==)(lhs, rhs)` resolving to the wrong overload.

**Root (see String==str issue file):** this session fixed the outer `!=`
specialization. The residual: inside the specialized `!=` body,
`not(Self.(==)(lhs:String, rhs:str))` — the `Self.(==)` DOT-call picks the
`Eq(String).==` (String,String) overload instead of the `(String,str)` `eq_str`
overload that the INFIX `==` correctly resolves. The infix path
(function.yo:1328, `is_infix_operator_call=true`) surfaces the str overload; the
dot-call path does not.

**Steps:**

1. Repro: `check :: (fn(s : String) -> bool)(s != "void"); ...` self-compiled →
   inspect the specialized `!=` body `fn_yo_id_2230_rtparam0_..._ret_bool`. TS emits
   `!=` → `id_47035` whose body calls the `(String,str)` `==` (`id_282`).
2. Make the specialized body's `Self.(==)(lhs, rhs)` (a dot-method-call) do the same
   arg-based overload selection the infix `==` does — i.e. surface + select the
   `(String, str)` overload (`eq_str`, imm/string.yo:650). Look at
   `_try_find_receiver_method` + `_select_matching_overload` (function.yo:182, 490)
   and how the infix path (function.yo:1328) passes `is_infix_operator_call=true`
   to `get_receiver_methods_by_name_from_env`; the dot-call passes `false`.
3. NOTE the "take the address with &" variant suggests a self-by-pointer mismatch
   (`eq_str`/`==` may expect `self` by value but the call passes a `*Self`, or vice
   versa) — check the receiver arg lowering for the specialized method call.

**Validate** as §1. Low count; may be deferrable if the type-identity family (Phase 4)
subsumes it.

---

## Phase 4 — type-identity + syntax cascade (remaining ~24: assigning/int-conv 16, expected-expression 12, misc)

**This is the deepest family** (roadmap: "~9 approaches exhausted"). Do it LAST —
some of it likely CLEARS once Phases 1-3 land (the "expected expression" 12 are
SYNTAX CASCADES downstream of malformed functions produced by the incompat/skip
breakage; count them AFTER each earlier phase).

**Errors:** `assigning to '__yo_t401 *' from 'bool'` / `from '__yo_t405 *'`
(int-conversion + incompatible-pointer), `expected expression` ×12 (cascade),
`variable has incomplete type`, `operand ... where arithmetic or pointer required`.

**Root (roadmap "INCOMPAT" entries):** generic-instantiation type identity — a
generic struct/enum's `id` (and method-registry key) omits type arguments, so
different instantiations (`Iter(usize)` vs `Iter(String)`) collide onto one
specialized function whose baked return/field type mismatches the call site. The
prior session's `type_arguments`-in-exact-compat fix (commit `9e4077300`) cut this
a lot; the residual is same-base-id generic-ENUM instantiations + the
`with_capacity`/`Self`-return specialization collapse (impl-level `K,V` not in the
method's sig).

**Steps:**

1. RE-MEASURE after Phases 1-3 — the count + distribution will have shifted; several
   "expected expression" cascades should be gone. Re-triage.
2. For each remaining incompat: read the emitted C at the error line, identify the
   two mismatched types (`__yo_t401` vs `__yo_t405`), and trace which specialized
   function baked the wrong type. Minimal-repro it; confirm TS clean.
3. The faithful fix is threading impl-block/`Self` type params (`K,V`) into the
   method's specialization signature so instantiations don't collapse — see the
   roadmap's detailed "ENUM-INCOMPAT 44" + "with_capacity impl-forall-not-in-sig"
   analysis and memory `yo-self-parametric-trait-impl-self-subst`. This is
   multi-site and regression-prone; validate + revert-on-regress each attempt.
   Do NOT append `self_type` to `runtime_param_tys` (documented +2634-error regression).

**Validate** as §1 after every attempt (this family has a long history of
attempts that made things WORSE — the corpus/std gates catch them).

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

## Quick reference — commit conventions

- Commit only validated changes (stage-2 down + corpus 103/103 DIFF 0 + std 152/152).
- End commit messages with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Run `./yo-cli fmt <file.yo>` on every `.yo` you touch before committing.
- Put new bug analyses in `issues/`, plan updates in `plans/`.
