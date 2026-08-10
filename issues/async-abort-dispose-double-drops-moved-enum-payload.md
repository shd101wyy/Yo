# Async abort-dispose double-drops: moved-into-dyn payloads (open) and awaitless-match bindings (FIXED)

**Status: the binding pair is FIXED in TS (2026-08-11); the move-out pair
remains band-aided by a call-site clone.** Found by the new
`tests/internal/version.test.yo` "read_yo_version: throws on invalid
content" port under the Linux/ASan internal-tests arm (PR #93). macOS does
not reproduce (AMFI blocks the test-runner's ASan dylib there, and without
ASan the double-free is silent).

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
