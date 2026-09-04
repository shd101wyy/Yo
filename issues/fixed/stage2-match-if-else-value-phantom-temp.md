# Stage-2 miscompile: if-else value inside a match arm dups a phantom temp with the WRONG type

**Status: FIXED** 2026-08-10 (`yo-self/codegen/exprs/cond.yo`,
`yo-self/codegen/exprs/match.yo`). Found by the first self-hosted `yo build`
self-build; reduced to 25 lines and root-caused the same day.

**Root cause (established by instrumenting `expr_info_table_set` and the
cond arm-value reader):** TS clears `expr.$.variableName` around the RAW
generation of a dup-carrying value (7 sites: cond.ts:299/418, match.ts:134,
return.ts:73/588/601, begin.ts:114) so the atom generator cannot return the
info's temp alias. yo-self had ported only 3 of the 7. Without the clear,
generating the else-value atom `ps` returned the NOT-YET-DECLARED temp name,
the `vtv != raw_code` declaration was skipped, and every use referenced an
undeclared identifier. (The "wrong type" appearance was a red herring — the
Option-shaped dup is String's newtype underbelly, correct all along.)
`cond.yo` and `match.yo` now do the exact TS dance (ExprInfo is a ref
struct, so the handle mutation mirrors TS mutating `expr.$`). `begin.yo` is
missing TS's whole last-arg deferred-dup block — a LATENT gap recorded in
plans/archive/P2_RETIRE_SRC.md, not part of this fix.

Reducer (fails in seconds):
[`repros/stage2-match-if-else-value-phantom-temp.yo`](repros/stage2-match-if-else-value-phantom-temp.yo)

```bash
./yo-cli compile yo-self/main.yo --release -o /tmp/yo-s1      # TS-built stage-1
YO_STD=$PWD/std /tmp/yo-s1 compile \
  issues/repros/stage2-match-if-else-value-phantom-temp.yo -o /tmp/x --release
# → clang: use of undeclared identifier '_file____User_temp_N' (×2, +1 more)
```

The TS compiler compiles the same file clean (prints `.` and `a/b`). The
shape, from `run_build`'s `project_dir` in `yo-self/build_runner.yo`:

```rust
io.async((aio : Io) => {
  project_dir := match(
    build_file_path.parent(),                      // Option(Path)
    .Some(p) => {
      ps := p.to_string();
      if(ps.len() == usize(0), String.from("."), ps)   // ← the else value
    },
    .None => String.from(".")
  );
  aio.await(yield(aio), aio);                      // async matters? (unverified)
  return(project_dir)
})
```

## What the self-hosted compiler emits (else branch)

```c
else {
  __yo_t7 temp_dup_enum_… = _file____User_temp_6142;   // ← NEVER DECLARED
  switch ((temp_dup_enum_…).tag) { … __yo_incr_rc … }  // ← dup as OPTION
  temp_dup_enum_…;
  _file____User_temp_6143 = _file____User_temp_6142;   // ← String slot = Option temp
}
switch ((ps).tag) { … __yo_decr_rc((ps).data.Some.value) … }  // ← drops STRING as OPTION
```

The else value is `ps : String`. The emission treats it as an
**Option** (the OUTER match scrutinee's type — `parent()` returns
Option(Path)) named by an eval temp that was never emitted.

## Analysis so far

The path taken is `cond.yo`'s arm-value deferred-dup branch
(`codegen/exprs/cond.yo:194-315`): `context.base.get_expr_info(value)` for the
else-value atom returns an ExprInfo whose `variable_name` is the phantom temp
and whose `ty` is the Option — someone else's entry. `_call_generate_expr` on
the atom returns the same phantom name (atom codegen also reads the poisoned
info), so the `vtv != raw_code` guard that would have declared the temp is
skipped, and the dup/drop code is generated from the wrong `ty`.

TS cannot express this failure: its ExprInfo lives ON the node (`expr.$`).
yo-self keys a process-wide side table by expr id
(`mm_set_shared_expr_info_table`), so two nodes sharing an id COLLIDE. The
`if(...)` here is a macro expansion (`if` → `cond`) inside a match arm inside
an `io.async` — the known id-identity hot zone (see
`clone_expr_fresh_ids`, the recur macro-expansion side-table fix, and the
"STALE eval temp (re-evaluation drift)" escape hatch already in cond.yo,
which this case slips past because the drift check compares against the SAME
poisoned info).

## Attack plan for the next session

1. Instrument: in the reducer run, log the expr id of the else-value atom at
   evaluation time and every writer to that id in the ExprInfoTable
   (`expr_info_table_set`) — find the second writer.
2. The fix is at the identity level (fresh ids for the colliding structure,
   or a compound key), NOT another codegen-side drift hatch — cond.yo already
   has one and it cannot help when the value generation itself reads the
   poisoned entry.
3. Verify: reducer clean under stage-1; then `fixpoint_only.sh` (stage-2 ≡
   stage-3) — and remember `gates_fast.sh` does NOT cover this.

## Related

- `issues/self-hosted-debug-emission-undeclared-temp.md` — SAME BUG, observed
  earlier through the debug-mode lens before the bisect showed `--release`
  fails too. Fold into this issue when fixed.
