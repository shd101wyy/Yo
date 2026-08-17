# Env-sharing v1: live frame membership leaks into def-time envs (fd-drop miscompile)

**Status:** OPEN — found during the env-sharing implementation
(`plans/backlog/YO_SELF_ENV_SHARING.md` §3), branch `p2/env-sharing`,
commit `eb3f2b8fb` (the naive sharing port). Blocks landing the memory fix.

## Symptom

A stage-1 built from the naive-sharing tree emits C where `fd := ...`
declaration statements inside `std/fs/file.yo` methods are silently DROPPED
while later references keep the bare name — the C does not compile
(`use of undeclared identifier 'fd'`), and where it slips past clang it would
be a silent miscompile:

```c
static inline _..._state_t* yo_id_6344(__yo_t14* self, uint8_t* buf, uint32_t size, __yo_t22 io) {
  // MISSING under sharing:  int32_t _temp = self->_fd;  int32_t fd = _temp;
  _..._state_t* t = __yo_new_...((__yo_t36){.size = size, .fd = fd, .buf = buf});
  return t;
}
```

4 sites in a self-compile (all `fd :=` in `std/fs/file.yo`: `read`'s sync
prelude, `open_with`'s async-closure body, and 2 more). Fixpoint gate fails
(`CLANG_RC=1`). Byte-identity vs the flatten baseline shows the same 4 drops
plus benign id renumbering (94,463 raw diff lines reduce to these 4 sites +
one closure-id ±1 shift after id-class normalization).

Repro (~30 s per emit): compile a program that calls `File.open` + `File.read`
(`io.await(File.open(...), io)` etc., with `pragma(Pragma.AllowUnsafe)`)
with a sharing-built stage-1 vs a flatten-built one; grep the emitted C for
`int32_t fd = ` (2 under flatten, 0 under sharing).

## Trigger

`std/fs/file.yo`'s `impl(File, ...)` declares a **method named `fd`**
(line ~218) AFTER the methods (`read` line ~98, `open_with` line ~57) whose
bodies bind a local `fd :=`. Renaming the method (or the locals) makes the
sharing build emit correctly — confirmed by probe.

Impl method fields ARE env-visible to later sibling field def-evals, and Yo
forbids shadowing: moving the `fd` method BEFORE `read` makes ALL THREE
compilers (TS included) reject the file with
`Variable "fd" is already defined here (variable shadowing is not allowed)`.
So the std file compiles only by definition order — the local `fd :=` binders
are legal solely because the method binding does not exist yet when their
bodies are def-evaluated.

## Root cause: a representation divergence, not the sharing idea

TS `addVariableToEnv` (src/env.ts:660-688) is **persistent**: it builds a
new frame + a new frames list + a new env. Any env captured earlier — a
def-time body env, an `ExprInfo.env` — keeps point-in-time frame MEMBERSHIP
forever. TS can hand the caller env to a def-time body eval by reference
(function-type.ts:296-304) because nothing ever appends into a frame object.

yo-self frames are `ref(struct(...))` with **in-place append**
(`add_variable_to_env` pushes into `frame.variables`; the `g_frame_indexes`
machinery is built on "frames only ever append"). The old flattening copy in
`_build_def_time_body_env` was accidentally providing TS's insulation: the
def env's outer frames were private copies, so the later `fd` method binding
never appeared in `read`'s def env or in the `ExprInfo.env` snapshots taken
during `read`'s body eval. Naive sharing (`snapshot_env` = new frames LIST,
same live frame objects) removed the insulation: after the impl loop binds
the `fd` method into the shared frame, every recorded env from `read`'s
def-eval retroactively "contains" a comptime `fd` — and a codegen-time
by-name policy check (`_last_is_compile_time_only` /
`_last_is_module_level` in `codegen/exprs/assignment.yo`, exact gate
per the instrumented run) reads the live frames and skips the statement.

The def-time trials themselves all pass (`YO_DEBUG_SWALLOW` shows
`out=1 pending=false` for every `fs/file.yo` field; no swallow, no re-trial)
— the corruption is purely in what the recorded envs mean at codegen time.

## Fix direction (option A — frame-membership snapshot)

Share the **Variable handles** but not the mutable frame objects: in
`_build_def_time_body_env`, rebuild every frame as a new `Frame` (same `id`,
same `where_clause_constraints` handle, fresh `index_key`) whose `variables`
is a NEW list of the SAME Variable handles; filter frames 1+ by the keep
predicate in the strip case. Frame 0 must be rebuilt too (unlike
`keep_top_level_frame_and_comptime_variables_from_env`, which shares it
as-is) because yo-self's module frame 0 mutates in place — TS's frame 0
reference is immutable-by-construction, so "share frame 0" in TS ALREADY
means point-in-time membership.

This keeps ~97% of the memory win (8 B pointer per binding instead of a
~280+ B Variable copy + value cell + name buffer) and reproduces TS's
def-boundary semantics exactly. Measured for the naive sharing before it was
reverted: peak footprint 14.55 → 12.62 GB (−1.92 GB), wall 678 → 282 s on the
self-emit — option A should retain nearly all of it.

## Option A results (commit `9dda2a00a`)

- fd-drop repro FIXED (2 declarations, matching flatten).
- Peak footprint 14.55 → **12.21 GB (−2.34 GB)**, wall 678 → **283 s (2.4×)** —
  the full win survived membership freezing.
- Emitted-C comparison vs the flatten baseline: byte-level diff is id
  renumbering; after normalizing all generated-id classes the sorted multiset
  differs in only two benign ways:
  1. One FEWER duplicate `typedef ... (optimized as nullable pointer)` for an
     enum (127 vs 128 of that shape, everything else identical; the stage-2 C
     compiles clean) — sharing restores the type identity the flatten split,
     deduplicating one duplicate instantiation. An improvement.
  2. A per-field `set_effect` target flip that exposed a SECOND latent bug,
     fixed in commit `dde0bae5d`:

## Second latent bug: hash-order bundle-var pick (fixed)

`_find_bundle_var_field` (codegen/exprs/async.yo) took the FIRST type-matching
entry while iterating `state_machine_variables` — a `HashMap`, so hash order,
reseeded by any change to variable-id allocation. TS iterates an
insertion-ordered JS Map (async.ts:468-477), and TS's sibling
`findBundleFieldName` documents the intended semantics: prefer the ALIASED
closure-param slot ("reading from var\_<id> would see zero-initialized
memory"). With two same-typed candidates (std/fs/file.yo's closure bundle
param `e`, aliased `__yo_param_0`, plus a local `e`), env-sharing's id reseed
silently flipped the pick to the dead local slot. Dead code today — all 246
`set_effect` call sites in a self-compile pass `"__bundle"` — but a latent
wrong-target. Fix: collect all matches, prefer aliased, tie-break by
numerically smallest id (monotonic ids ⇒ smallest = first-inserted = TS's
first-match).

Lesson (repeated, now twice in one session): first-match-by-name/type over a
yo-self `HashMap` is a latent nondeterminism wherever TS iterates a Map —
same class as the PR #92 Linux capture-field bug.
