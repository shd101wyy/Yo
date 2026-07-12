# Stage-2 fixpoint blocker: ~60GB RC leak in eval phase (NOT a hardware limit)

## Status: OPEN — root localized, fix pending

## TL;DR — the diagnosis was wrong

The plan (`plans/YO_SELF_STAGE2_HANDOFF.md`, item 3) records the fixpoint
(`stage-2.c ≡ stage-3.c`) as blocked by codegen memory, remedy = "run on a
32GB+ box" (task #21). **That premise is wrong.** The self-compiled binary (s2)
does not merely _use a lot of_ memory — it **leaks ~60GB** compiling
`yo-self/main.yo`. A 32GB box would not fix a 60GB leak. It is a **fixable RC
bug**, not a hardware ceiling.

## Evidence

Control (s1 = yo-self compiled by TS `--release`) compiling `main.yo`:

- **76 seconds, peak RSS 9.2GB, COMPLETES.** Emits a 30,596,242-byte C file.

Same input, s2 (= yo-self compiled by s1, i.e. `stage-2.c` built at `-O2`):

- Runs 3.8–5.7 min, then **SIGKILL (rc=137)**.
- RSS stays ~3.4GB (misleading — macOS _compresses_ the leaked heap).
- True footprint (`top -stats mem,cmprs`) balloons: **27G→36G→56G→73G**
  (52–70G compressed) → jetsam kills it.

The leak is in the **EVAL phase**, not codegen: `s2 check main.yo` (evaluator
only, no C emission) balloons to 56–73GB identically. (An earlier note claimed
`check main.yo` was "bounded 3.3GB" — that measured RSS, which compression
holds flat; the footprint was already ballooning.)

s1 completing in 76s/9.2GB while s2 leaks 60GB on the _same source_ ⇒ this is a
**yo-self codegen / RC-lifecycle divergence from TS**, exactly the faithful-port
bug class. (TS uses a tracing GC that reclaims dead eval state for free; yo-self
uses RC + Bacon-Rajan cycle-GC and must drop it explicitly.)

## What leaks (live-heap breakdown, `heap -s` at 15s / 3.5GB / 35M live nodes)

| live count | avg bytes | site                                          | what                                    |
| ---------: | --------: | --------------------------------------------- | --------------------------------------- |
|  2,729,549 |       320 | `yo_id_20437` = **`new_variable`**            | env Variable records                    |
|  5,885,763 |        68 | `yo_id_20024`                                 | Variable sub-alloc (name String / etc.) |
|  5,954,076 |        60 | `yo_id_11997`                                 | ”                                       |
|  5,861,472 |        56 | `yo_id_4830`                                  | ”                                       |
|  1,854,763 |       154 | `yo_id_260821`                                | call dispatch                           |
|  1,100,193 |       151 | `yo_id_264811` = **`evaluate_function_call`** |                                         |

Dominant leaker = **`new_variable`**: the per-call callee-environment Variables
bound during **def-time body evaluation** are never freed. Over the whole
compiler's millions of def-time calls they accumulate to ~60GB. (`heap` without
MSL showed 195M live 80-byte objects at 23G — same story, later in the run.)

`callee_env` in `stage-2.c` has **9 `incr_rc` : 2 `decr_rc`** — a large net
retention imbalance: the callee environment (and, transitively, its Variables)
is retained far more than released.

## Two confirmed contributing divergences

1. **`evaluate_function_call` early-return drop omission.** Between the
   `evaluated_callee` `___dup` incr (`stage-2.c:366996`) and its single
   scope-end decr (`374265`) there are **140 early `return`s**, and **none**
   decr `evaluated_callee`. Each "Drop local variables before early return"
   block omits it. (This one pins bounded existing AST nodes, not the 60GB, but
   it is a real leak on the special-case call paths.)

2. **`return.yo` `_keep_pending_drop` has a yo-self-only over-broad guard** that
   TS (`src/codegen/exprs/return.ts:306-354`) does **not** have
   (`yo-self/codegen/exprs/return.yo:206-209`):
   ```
   c_name := sanitize_for_c_identifier(var_name, false);
   if(!(context.base.declared_c_var_names.contains(c_name)), { return(false); });
   ```
   It was added because yo-self records the **end-of-scope env** (not TS's
   point-in-time env), so it approximates "is this var initialized here yet?"
   via C-emission order (`declared_c_var_names`). If a legitimately-declared
   local is **not registered** in `declared_c_var_names`, its early-return drop
   is wrongly suppressed → leak. This is the prime suspect for the systematic
   callee-env/Variable drop omission on the hot early-return paths.

## The mechanism (decisive): throw-path drop omission × swallowed trial-eval throws

The 140 "early returns" in `evaluate_function_call` are almost all
`if (__yo_effect_escaped) { <drops>; return (__yo_t26*){0}; }` — i.e.
**throw/exception propagation** paths, taken when a `throw` unwinds through the
`exn.throw(...)` call and sets `__yo_effect_escaped`.

Def-time body evaluation **trial-evaluates** every function body and
**swallows** the failures (see `yo-self-defeval-wall` /
`yo-self-test-trial-eval-swallow`). So during `check main.yo` these throw paths
fire **constantly** — on the order of once per failed body eval, i.e. millions
of times across the whole compiler.

Each throw-path drop block _does_ drop the local `Option` temps, but it
**omits** `callee_env` and the per-call bound Variables (`new_variable`
results). TS's tracing GC reclaims that now-unreachable state for free; yo-self
must drop it explicitly on the throw path and does not. Millions of
swallowed-throw unwinds × leaked callee-env Variables = the ~60GB.

This is why the leak is invisible on small inputs (`check parser.yo`, 6s, few
throws) but catastrophic on `main.yo` (whole compiler, millions of trial-eval
throws), and why it is eval-phase, not codegen.

## Why no GC config helped (and why the "32GB box" remedy is a red herring)

The leaked callee-env state is **reachable** (pinned by explicit over-retention
/ missing drops), not unreachable cyclic garbage. Neither RC nor the cycle-GC
(`can_type_form_rc_cycle`, which IS implemented, not stubbed) frees reachable
objects. So every `YO_GC_*` setting still OOM'd — consistent with a
drop-emission leak, not a collector gap.

## Fix direction (next dedicated effort)

Make yo-self's codegen drop the per-call callee environment (and recursively its
Variables) on **all** exit paths of the call-evaluation functions, matching what
TS's GC reclaims. Concretely:

1. Audit the `callee_env` lifecycle in `evaluate_function_call` /
   `yo_id_260821` / the body-execution helper (`yo_id_260010`) — find where the
   9:2 incr/decr imbalance originates.
2. Fix the `declared_c_var_names` completeness gap (or narrow the guard) so
   legitimately-declared locals are dropped on early returns — port TS's
   point-in-time `initializedAtToken` semantics faithfully rather than the
   end-of-scope-env approximation.
3. Verify: `s2 check yo-self/main.yo` footprint stays bounded (~≤10GB, like s1),
   then run the fixpoint `s2 compile … --emit-c` and diff `stage-2.c` vs
   `stage-3.c`.

## Repro / tooling

```bash
# s1 control (completes 76s/9.2GB):
YO_MAIN_STACK_MB=4096 /tmp/yo-self-s1 compile yo-self/main.yo --release \
  --emit-c --skip-c-compiler -o /tmp/s2ctl

# s2 leak (footprint balloons — WATCH cmprs, RSS lies):
YO_MAIN_STACK_MB=4096 /tmp/yo-self-s2o2 check yo-self/main.yo &
top -l 1 -pid <pid> -stats mem,cmprs   # 27G→73G

# live-heap leaker breakdown:
MallocStackLogging=1 /tmp/yo-self-s2o2 check yo-self/main.yo &
sleep 15; heap <pid> -s | head -20     # yo_id_20437 (new_variable) #1
```

Note: `malloc_history -allBySize` is too slow (times out) at this allocation
volume; use `heap -s` (fast, MSL-derived site names).
