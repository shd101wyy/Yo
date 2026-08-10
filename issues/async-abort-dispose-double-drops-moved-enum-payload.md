# Async abort-dispose double-drops an enum payload moved into a thrown dyn

**Status: OPEN** (2026-08-10). Found by the new
`tests/internal/version.test.yo` "read_yo_version: throws on invalid
content" port under the Linux/ASan internal-tests arm (PR #93). macOS does
not reproduce (AMFI blocks the test-runner's ASan dylib there, and without
ASan the double-free is silent).

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
