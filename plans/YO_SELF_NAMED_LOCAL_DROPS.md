# yo-self: schedule begin-block scope-end RC drops for owning named locals

**Status:** ready to implement (focused session). Diagnosis is complete + rigorous;
this doc is turnkey — a fresh session can execute it without re-deriving.

**One-line:** yo-self never emits scope-end `___drop` for owning *named-local* bindings
(`x := New(...)`), so it leaks every named local. Port the TS begin-block scope-drop
scheduling into `yo-self/evaluator/exprs/begin.yo`. ⚠️ Delicate RC change (double-free/UAF
risk); validate with TS-ASan + the corpus + `tracked_count` every iteration.

Tracked as **task #38**. Related: `issues/yo-self-cycle-gc-runtime-port.md` (gap #3),
`plans/CYCLE_GC_TRACE_HOOKS.md` §4 (this is its real root), `plans/BOOTSTRAPPING_CODEGEN.md`
phase 4 ("complete consume-tracking mirror" — this is part of that remaining work).

---

## 1. The gap (confirmed, precise)

yo-self does **not** schedule begin-block scope-end RC drops for owning **named-local
bindings**. It is **not** a total RC absence — it *does* drop call-arg/clone temporaries +
return-path values (proven by the documented yo-self double-free fix
`return_call_clone_arg_drop`, BOOTSTRAPPING_CODEGEN.md:181-189 — you cannot double-free
without dropping; `other_fn_call.yo` / `return.yo` / `match.yo` all call
`generate_deferred_drop_expressions`).

**Evidence (tracked_count probe — see §6):** TS drops every named local (all patterns
`0→0`); yo-self leaks every named local (monotonic `0→1→2→3…`) across local /
pass-to-owned-param / returned-value / field-store / unit-tail / value-tail /
explicit-`return`. A `Dispose` impl also does not fire when a local exits scope (TS prints
`disposed 7`, yo-self doesn't). Consistent with yo-self's ~2× self-compile memory (P2 task
#21: named locals leak, temps drop) and with the cycle tests "collecting" partly by
RC-error **cancellation** (yo-self also omits dup-on-store, so the two errors offset for
cyclic objects; leaks only surface for non-cyclic objects like the `ENil` terminators).
The behavior-based corpus can't see leaks, which is why this went unnoticed.

## 2. Mechanism + exact code anchors

- **Codegen is already wired.** The function-body generator emits a block's drops:
  `yo-self/codegen/functions/generation.yo:102,116` → `generate_deferred_drop_expressions(body_expr, …)`
  (`codegen/exprs/drop_dup.yo:384`), which simply **reads** `ei.deferred_drop_expressions`.
  `codegen/exprs/begin.yo` `_emit_deferred_drops` does the same for nested blocks. **Nothing
  to change in codegen.**
- **The eval never populates the field for named locals.** `yo-self/evaluator/exprs/begin.yo`
  evaluates the block but never builds `deferred_drop_expressions` for the frame's owning
  locals. The eval-side builder **already exists**:
  `yo-self/evaluator/calls/helper.yo:234 generate_deferred_drop_expressions(variables_to_drop,
  env, ctx, exn) -> Option(ArrayList(AstExpr))` (builds + evaluates `___drop(name)` per var).
  It is exported but has **zero evaluator callers** (only `suspension_analysis.yo` + `recur.yo`
  ever set `deferred_drop_expressions`, neither for plain scope-end).
- **`Variable` already carries every field the predicate needs** (`yo-self/env.yo:58`):
  `is_owning_the_rc_value : bool`, `consumed_at_token : Option(Box(Token))`,
  `is_module_level : bool`, `is_owning_the_same_rc_value_as`, plus the by-ref-borrow field
  (verify its exact name ~`env.yo:109`). So the data model fully supports the fix.

## 3. TS reference (what to port)

`src/evaluator/exprs/begin.ts`:
- **Predicate** `variableCanNeedDropIgnoringConsumed` (lines **242-257**): drop-eligible iff
  `isOwningTheRcValue` && `typeContainsRcType(type)` && `!isModuleLevel` && NOT an unresolved
  `SomeType` (`isSomeType && !resolvedConcreteType && requiredTraits.length===0` → false).
- **Builder** `generateDeferredDropExpressions` (lines **273-334**): for each var, build +
  evaluate `___drop(name)` (expected type unit), collect into an array. **Already mirrored**
  by yo-self `helper.yo:234` — reuse it.
- **Main collection / scope-exit** (lines **2065-2231**): iterate the current frame's
  variables, filter by the predicate **and** `!consumedAtToken`, build the drops, and set
  `expr.$.deferredDropExpressions`. Also handles early-return-only drops (a var declared
  before a `return` is dropped on that return path) — see
  `attachEarlyReturnOnlyDropExpressionToReturns` and the `return`/`unwind` handling.
- **Move/return exclusion**: the block's RESULT/returned var is moved out (consumed) — it
  must NOT be scope-dropped (lines ~1738-1772 mark the returned var consumed).

## 4. yo-self insertion point (precise)

In `yo-self/evaluator/exprs/begin.yo`, the post-loop tail (read lines 673-823):
- The top frame (pushed at **line 251** `env.push_frame(true)`) is captured as
  `current_frame_opt` at **lines 770-775**, just before `env.pop_frame_nonmutating()` at
  **line 783**.
- **Insert the scope-drop scheduling between line 775 and line 783** (frame still live, names
  resolvable): collect drop-eligible vars from `current_frame_opt`'s variables, call
  `generate_deferred_drop_expressions(vars, env, ctx, exn)`, keep the result.
- After `out_info` is built (**line 787**), set `out_info.deferred_drop_expressions = <result>`
  (before `expr_info_table_set` at line 819).
- Import `generate_deferred_drop_expressions` from `../calls/helper.yo` into begin.yo.
- Confirm the `Frame` struct's variables-list field name (grep `Frame ::` in `env.yo`).

**Drop-eligible predicate (per frame var):** `is_owning_the_rc_value` &&
`type_contains_rc_type(ty)` && `!is_module_level` && NOT-unresolved-SomeType &&
`consumed_at_token.is_none()` && NOT-by-ref-borrow && **name ≠ the block's result/returned
var** (`last_info.variable_name`, and the returned-local case). Excluding consumed + result +
borrow is the **safety-critical** part.

## 5. The dup/drop COUPLING (read before implementing)

yo-self omits **both** dup-on-store and scope-drops; they are currently **balanced** (leak,
no crash). Adding drops without matching dups corrupts memory:

- **Construction** (`b := N(5, Some(a))`): both compilers MOVE `a` into `b` (no dup). TS
  drops only the survivor `b` at scope end (which transitively drops `a`). Here **drops
  alone are correct** — `a` is consumed into `b` (must be excluded via `consumed_at_token`);
  dropping `b` is right. Verify yo-self marks `a` consumed here.
- **Reassignment** (`a.next = b`): TS emits `a->next = __dup(b)` **and** drops the old
  `a.next`. yo-self emits **neither**. If you add scope-drops of `a`/`b` (named locals) but
  NOT the dup-on-reassign, you get **UAF**: e.g. in `form_cycle` (`a.next=b; b.next=a`),
  dropping `a` at scope end frees it while `b.next` still points to it. **So the
  reassignment dup-on-store fix is coupled to the drop fix and they must co-land** (the
  corpus's `ref_enum_cycle` exercises reassignment and will UAF/crash under ASan if drops
  land without dups). TS reassignment dup/drop scheduling lives in `assignment.ts`; yo-self
  `evaluator/exprs/assignment.yo` already calls `set_expr_as_needs_to_call_dup(prop_rhs)`
  (line 388) but the dup isn't emitted — trace why (the marking → codegen-emission path).

## 6. Validation harness (durable copies — /tmp originals are ephemeral)

**Probe A — every-pattern leak check** (expect ALL `→` equal once fixed):

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/libc/stdio.yo"));
Gc :: import("std/gc");
N :: ref(struct(v : i32, next : Option(Self)));
p1_local :: (fn() -> unit)({ x := N(1, Option(N).None); (); });
sink :: (fn(n : N) -> unit)({ (); });
p2_pass :: (fn() -> unit)({ x := N(2, Option(N).None); sink(x); });
mk :: (fn() -> N)(N(3, Option(N).None));
p3_return :: (fn() -> unit)({ y := mk(); (); });
p4_field :: (fn() -> unit)({ a := N(4, Option(N).None); b := N(5, Option(N).Some(a)); (); });
main :: (fn() -> unit)({
  b1 := Gc.tracked_count(); p1_local();  a1 := Gc.tracked_count(); unsafe(printf("p1 %llu->%llu\n", b1, a1));
  b2 := Gc.tracked_count(); p2_pass();   a2 := Gc.tracked_count(); unsafe(printf("p2 %llu->%llu\n", b2, a2));
  b3 := Gc.tracked_count(); p3_return(); a3 := Gc.tracked_count(); unsafe(printf("p3 %llu->%llu\n", b3, a3));
  b4 := Gc.tracked_count(); p4_field();  a4 := Gc.tracked_count(); unsafe(printf("p4 %llu->%llu\n", b4, a4));
});
export(main);
```

**Probe B — Dispose-fires-on-scope-exit** (expect `disposed 7` to print, between `using 7`
and `after`):

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/libc/stdio.yo"));
Res :: ref(struct(id : i32));
impl(Res, Dispose(dispose : (fn(self : Self) -> unit)({ unsafe(printf("disposed %d\n", self.id)); })));
useit :: (fn() -> unit)({ r := Res(7); unsafe(printf("using %d\n", r.id)); });
main :: (fn() -> unit)({ useit(); unsafe(printf("after\n")); });
export(main);
```

**Per-iteration validation gates (ALL must pass):**
1. Probe A: yo-self prints all `→` equal (was monotonic leak); matches TS.
2. Probe B: yo-self prints `disposed 7`.
3. **TS-ASan** on Probes A+B and on a handful of reassignment-heavy programs
   (`tests/cycle_collector.test.yo`, `form_cycle`): no leaks reported, **no UAF/double-free**.
   (yo-self's own ASan binary hangs for an unrelated reason; the emitted runtime is a verbatim
   port, so TS-ASan on the same source is representative — but ALSO run the yo-self-compiled
   binary normally to catch crashes.)
4. **Corpus 0-diff**: `YO_SELF_BIN=/tmp/yo-self-bin scripts/diff-test.sh tests/codegen-bootstrap/
   --parallel 4` → PASS unchanged, **DIFF 0, SELF-FAIL 0** (a double-free crashes a program →
   shows as SELF-FAIL/DIFF). This is the primary safety net.
5. `./yo-cli check ./std` 152, `check ./tests` unchanged (build the new yo-self-bin first).
6. `ref_enum_cycle` / `arraylist_self_cycle` still collect (and ideally return to baseline
   once dup-on-reassign also lands — flip their assertions from `after < mid` to
   `after == before`).

Build loop (no `--release`, per memory): `./yo-cli compile yo-self/main.yo -o /tmp/yo-self-bin`
(~6 min). ENV: `export BUN=/nix/store/*-bun-1.3.*/bin/bun` (bun drops from PATH);
`YO_MAIN_STACK_MB=4096` for the yo-self binary.

## 7. Incremental milestones

1. **M1 — predicate + collection (drops only), reassignment EXCLUDED.** Implement the
   scope-drop scheduling in begin.yo, but conservatively SKIP any var that was reassigned-into
   a managed field (or just skip vars involved in any `a.f = …` in the block) so reassignment
   code keeps its current balanced-leak behavior (no UAF). Validate gates 1-5; cycle tests
   should be unchanged (still leak-by-cancellation). This safely fixes the common case
   (p1-p4, Dispose) without touching the coupled reassignment path.
2. **M2 — dup-on-reassign.** Fix `assignment.yo` to emit `__dup(RHS)` + drop the saved
   old-value on managed-field reassignment (trace the `set_expr_as_needs_to_call_dup` →
   emission gap). Then REMOVE the M1 reassignment exclusion. Validate gates 1-6 + ASan on
   `form_cycle` (the coupled case); cycle tests should now return to baseline.
3. **M3 — early-return / control-flow drops.** Port the before-`return`/`unwind` drop
   emission (TS `attachEarlyReturnOnlyDropExpressionToReturns`) so a local declared before an
   early `return` is dropped on that path. Validate.
4. **M4 — regression tests.** Add Probe A + Probe B as `tests/codegen-bootstrap/` differential
   tests (now both compilers print identically). Add a `tests/cycle_collector.test.yo` /
   corpus assertion that survivors return to baseline.

## 8. Risks / invariants

- **Double-free/UAF is the failure mode**, not leaks. Wrong exclusions (dropping a consumed /
  returned / borrowed / dup-less-stored var) corrupt memory across the whole corpus. Be
  conservative: when unsure whether a var is consumed, DON'T drop it (leak > corruption).
- **Closure captures**: a var captured into a closure's capture struct is dup'd into the
  struct; the codegen already skips closure-capture drops (`is_deferred_drop_for_closure_capture`).
  Ensure the eval-side scheduling doesn't double-schedule.
- **`ref`/`inout` params and borrows**: never drop a borrowed binding (it doesn't own).
- **Def-time body eval**: begin.yo runs at def-time (the def-eval wall). Scheduling drops there
  must not perturb the trial-eval/swallow machinery; the drops are evaluated via
  `evaluate_expression_raw` inside `helper.yo:234`. Watch for interaction with
  `is_evaluating_function_body_or_async_block` gating.
- **1-to-1**: keep behavior identical to TS; validate via corpus 0-diff (behavior) + ASan.

## 9. Final docs/records to update when done

- `plans/CYCLE_GC_TRACE_HOOKS.md` §4 → mark drop-on-reassign resolved.
- `issues/yo-self-cycle-gc-runtime-port.md` → move to `issues/fixed/` if fully closed.
- `plans/BOOTSTRAPPING_CODEGEN.md` phase 4 → update consume-tracking/RC status; note the
  self-compile memory impact (P2 task #21) if measurable.
- Update the `cycle-gc-trace-hooks-progress` memory + task #38.
