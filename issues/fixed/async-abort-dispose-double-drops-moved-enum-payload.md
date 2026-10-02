# Async abort-dispose double-drops: moved-into-dyn payloads (open) and awaitless-match bindings (FIXED)

**Severity:** S1 — abort-dispose double-frees a moved enum payload (ASan-confirmed heap-use-after-free)

**Status: FIXED.** The binding pair was fixed in TS (2026-08-11). The
move-out pair is fixed by the single-pass lowering's per-type dispose
(#1018), and the call-site clone is gone (2026-10-01; last section). Found by the new
`tests/internal/version.test.yo` "read_yo_version: throws on invalid
content" port under the Linux/ASan internal-tests arm (PR #93). macOS does
not reproduce (AMFI blocks the test-runner's ASan dylib there, and without
ASan the double-free is silent).

One shape was still live on develop `29bf728b4`: the binding crosses an await inside the arm and
is then moved into the thrown `dyn`. The binding's slot and the scrutinee's `Err` payload hold the
same value without a dup, and the move zeroed only the binding's slot, so the abort dispose
released the payload again (valgrind: invalid read and invalid free in `_state_dispose_locals`).
The crash in front of it was
`issues/fixed/a-pattern-binding-moved-after-an-await-in-its-arm-reads-an-uninitialized-local.md`.

**Fix:** `_bind_pattern_name` (`src/codegen/exprs/match.yo`) records the place a binding was
initialized from when it lies in another slot (`InlineSmLowering.binding_sources`). A consuming
read of the binding (`_sm_consuming_read`, `src/codegen/exprs/atom.yo`) then zeroes that place
too, so the dispose and the scrutinee's scope-end drop see an empty payload. The zero invariant
now covers a value two slots hold. Test in `tests/async/sm_ownership.test.yo`: "a pattern binding
moved after an await in its arm is released once".

**History (TS era):**
The same throw path produced TWO distinct double-drop pairs, uncovered one
at a time:

1. **dyn temp + scrutinee slot** (the original report below): the arm MOVES
   the `.Err` payload into the thrown dyn; dispose drops both. Band-aided by
   `dyn(msg.clone())` at the call site; the mechanism fix is still open.
2. **pattern binding + scrutinee slot** (found after the clone landed — the
   shard-2 UAF persisted): an AWAITLESS match inside a state machine stores
   its pattern bindings into SM slots via the normal `match.ts` path, which
   never registered them in `asyncPatternBindingFieldIds` — only the
   match-WITH-await paths in `state-code-gen.ts` did (the PR #92 fix). So
   the abort dispose dropped `sm->var_msg` AND the scrutinee Result slot:
   same buffer, twice. **FIXED (TS)**: all four binding-store sites in
   `src/codegen/exprs/match.ts` now register the field id; verified
   structurally in the emitted C (binding drops gone from the `state == -2`
   list, scrutinee/owned drops intact) and by
   `tests/async_await.test.yo` "abort dispose skips awaitless-match pattern
   bindings" (162/162; rc 35, effects 74; `leaks --atExit` clean). yo-self
   needs no mirror yet: its `_store_temp_var_to_state_machine_if_needed` is
   still the documented no-op stub, so it never stores binding slots (that
   whole family's port is tracked in
   issues/fixed/async-match-scrutinee-deferred-drops-hit-zeroed-slot.md).

## ASan trace (batch harness, thread T1)

- **Object**: the ArrayList(u8) backing a String built by `+` concat inside
  `parse_yo_version` — the Err MESSAGE.
- **Freed and UAF-read by the SAME dispose fn** at two different offsets:
  `_yo…_temp_46569_state_dispose` (read_yo_version's aborted state machine)
  → `__yo_decr_rc` → free, then a second `__yo_decr_rc` on another field
  reaches the same buffer.

## Mechanism

`read_yo_version` (yo-self/version.yo) does:

```rust
match(parse_yo_version(content), .Err(msg) => e.exn.throw(dyn(msg)), ...)
```

The arm MOVES the enum payload `msg` into the thrown dyn. `exn.throw`'s
handler unwinds, the enclosing async state machine aborts, and its dispose
runs the registered field drops — including the slot holding the match
scrutinee (the `Result`), whose `.Err` payload was already moved out. The
move out of the matched payload is not recorded against the SM's dispose
drop set, so the same String drops twice: once via the dyn, once via the
scrutinee slot.

This is the RC policy/mechanism split family
(plans/backlog/RC_POLICY_MECHANISM_SPLIT.md): the abort-dispose path
replays declaration-time drops without seeing arm-level payload moves.

## Call-site patch (landed)

`read_yo_version` now throws `dyn(msg.clone())` — the clone owns its own
buffer, the scrutinee keeps its payload, dispose drops each once. The
regression test stays enabled; it exercises the same path and goes
UAF-free with the clone.

## Real fix (open)

Either record payload moves out of SM-slotted scrutinees in the dispose
drop set, or make `throw`-position moves from match arms clone by policy in
async contexts. Needs a targeted repro (`match` on an SM-held enum, arm
moves the payload into a value that outlives the abort) + ASan on Linux.

## Re-verified 2026-09-28 (async state-machine audit)

Tree build of develop `af62bdb28`, and the v0.2.45 seed unless noted. See `plans/ASYNC_STATE_MACHINE_GENERATION.md` §3.3.

**CHANGED: now a LEAK, not a double drop** (tree build). The doc had no runnable repro. `issues/repros/async-abort-dispose-leaks-local-slots.yo` builds the shape: a `match` on an SM-held `Result` whose `.Err(msg)` arm throws `dyn(msg)` without a clone, and the handler unwinds. ASan reports no double-free or UAF. LSan reports `171 byte(s) leaked in 5 allocation(s)`: the moved `msg`, `content`, their String headers, and the 64 B `__yo_task_abort_register` array. The emitted `_state_dispose` drops the captures and, only when `state == -1`, the result. It drops no local slot on abort (`local_var_drops` is empty for this body; `generate_async_block_state_dispose_function`, `src/codegen/exprs/async.yo`). Per-state drop tables (plan phase 4) are the structural fix.

## The binding pair, self-hosted (2026-09-29, async state-machine plan phase 1)

The self-hosted compiler now stores pattern bindings into SM slots (`match.yo`'s
state-machine storage parity store, and the two `state_code_gen.yo` binding
stores), so the binding pair came back: the `state == -2` dispose dropped
`sm->var_<binding>` and the scrutinee slot. For a `ref` payload (`Option(Thing)`
matched as `.Some(q)` across an await) this was a use-after-free already; once
the abort dispose learned to drop String locals it also hit
`tests/async_await.test.yo` "abort dispose skips awaitless-match pattern
bindings". **Fixed** the way the TS did it: every binding-store site records the
variable id in `FunctionGenerationContext.state_machine_binding_ids`, and
`generate_async_block_state_dispose_function` skips those ids. Test:
`tests/async/sm_ownership.test.yo` "an aborted task drops a pattern binding's
scrutinee once" (ASan UAF before, passes after). The moved-payload pair above
stays open.

## Fixed 2026-10-01: the move-out pair, and the band-aid removed

**Measured** on the v0.2.47 seed (the single-pass lowering, whose dispose
releases a task's live slots per type):
- `issues/repros/async-abort-dispose-leaks-local-slots.yo` is the move-out
  shape with no clone: a `match` on a `Result` whose `.Err(msg)` arm throws
  `dyn(msg)`, with the handler unwinding.
- With `--allocator system`, `leaks --atExit` reports `0 leaks for 0 total
  leaked bytes`. The 2026-09-28 tree build leaked 171 bytes in 5
  allocations.
- With `--sanitize address`, it runs clean: no double free and no
  use-after-free.

The regression test is `tests/async/sm_ownership.test.yo`'s "an arm that
moves its payload into a thrown dyn: the aborted task releases it once". The
thrown payload shares a counted `Thing` with a `keep` outside the task, so
the test checks the release count exactly: `rc(keep) == 1` after the abort.
A double drop would give 0, a leak 2.

`read_yo_version` in `src/version.yo` throws `dyn(msg)` again. The
internal `tests/internal/version.test.yo` "throws on invalid content", the
test that found this, covers it.
