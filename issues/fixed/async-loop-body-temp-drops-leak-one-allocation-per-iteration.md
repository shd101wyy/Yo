# An async loop body's intermediate temps leak: their drops read a state slot that never receives the store

> **FIXED 2026-09-25** on `mem/census-after-893`, by the codegen-side
> direction recorded below. Found again by the evaluator memory campaign: the
> compiler's own `_index_std_dir` walk leaked 748 strings and 209 paths per
> process through `read_dir` (the zero-hit `ArrayList(u8)` / `Path` census
> roots at the end of `check src/main.yo`).

Found by running the tier-1 battery locally under the runner's default ASan
(`yo test` builds every batch with `-fsanitize=address` on Linux):
`tests/fs/walker.test.yo` fails all 7 I/O tests with "Memory leak detected"
(24 more in file, 10 in temp, 13 in bufio).

**Attribution: PRE-EXISTING, and invisible to CI.** A binary built from the
pre-stack base (`f90b4d111`, before any safe-mode PR) fails the same walker
battery with the same leaks — this is not a regression from the safe-mode
stack. CI's ubuntu legs stay green on walker because LeakSanitizer does not
function in GitHub's containerized runners: the test runner carries an
explicit fallback (`"detect_leaks is not supported" → retry with
detect_leaks=0`, src/main.yo), so leaks are silently unobserved there. The
deck box's nix clang runs a working LSan, which is what exposed this — the
local gates are strictly stronger than CI on leaks.

## Reproducer (standalone, no walker needed)

```rust
// inside an io.async body's loop, after an await earlier in the loop:
//   name := String.from_cstr(name_ptr).unwrap();
// Four dirent iterations leak four 32-byte Option(String) temps.
```

`/tmp/yo-s1-local/walk_leak.yo` (walk a 2-file tree): LeakSanitizer reports
`Direct leak of 128 byte(s) in 4 object(s)` allocated inside
`_file_..._resume` (the read_dir async state machine) at the
`String.from_cstr(...)` call. The same shape leaks with `unwrap_or` — it is
NOT unwrap-specific.

## Root cause

The intermediate temp of the call (`_file____home_temp_773...`, the
`Option(String)` before unwrap) is classified as CAPTURED by the async
capture analysis: the state struct gains a slot
(`var__file____home_temp_773..._9885315842572961285`, visible in the emitted
C) and the temp's DEFERRED DROP is routed to state-machine completion,
reading that slot via a tag switch. But the temp is NOT live across any
await — it is created and consumed within one dirent-loop iteration — so the
capture-STORE step never writes the slot (correctly: nothing live to save at
the suspend). Result: the per-iteration drop never fires (it was hoisted to
completion) and the completion drop reads an empty slot. Every iteration
leaks the temp.

A synchronous control program (same intermediate-temp-in-loop shape, no
async) is clean under the same ASan build — the loop body's begin-epilogue
drops the temp per iteration. The defect is the async capture/drop routing
for loop-body-scoped temps, not the drop emission itself.

Verified pre-existing relative to the branch's later fixes: the identical
emission (slot allocated, drop routed to it, store missing) comes out of a
binary built BEFORE the branch's assignment-save gate, so the gate is not
the cause. Reproduced with both `unwrap` and `unwrap_or`.

## Fix attempts REFUTED (2026-09-23), to not repeat them

1. **Suppress capture in the deferred drop/dup walks** (suspension_analysis's
   `recur(drop_e, …)`). Fixes the leak but BREAKS COMPILATION of legitimate
   shapes: some minted temps' drops fire at a SHALLOWER scope than their
   declaring block (`use of undeclared identifier '_file____home_temp_…'`) —
   those need the slot. Reverted.
2. **Capture only when the target's block has closed** (frame-depth rule:
   `temp.frame_level >= owner_env.frames.len()` via the owning expr's
   ExprInfo env). Compiles clean but does NOT stop the leak — the loop temp
   still ends up captured, so the drop-walk is not the (only) capture
   channel: an ExprInfo env is a snapshot from BEFORE the frames its own
   body pushes, so the temp does not resolve in the owner's env and the rule
   conservatively captures. Reverted.

## Where the fix belongs

The promising direction is the CODEGEN side, channel-independent: when the
SM codegen declares a minted temp that is in `state_machine_variables`, emit
the slot store at the declaration (`sm->var_<id> = <temp>;`, a raw borrow
copy — the field's single drop then consumes the call's +1, the local
becomes a borrow; capture-stores at suspends write the same value raw, so
all writers agree). This fixes every loop-body temp at once and does not
depend on env archaeology. Any fix here needs the dup/drop emit-diff gate
plus an over-cancellation canary per AGENTS.md.

## Fix (2026-09-25)

The codegen side, as recommended above. `_store_temp_var_to_state_machine_if_needed`
(`src/codegen/exprs/other_fn_call.yo`) already existed for this contract ("a
local temp declared as a C local must ALSO be stored to its `sm->var_<id>`
field"), but only one site called it. Every temp-declaring site in that file
now calls it right after the declaration:
- the constructor results: enum, ref struct, union, value struct (the struct
  literal `raw.push({ name : name, ... })`);
- the direct and indirect call results;
- the three method-call results: dyn vtable, dot-method (`String.from_cstr(p)`,
  `String.from(".")`), and the rewritten slice call.

The helper skips `.Outer` captures and Future-typed temps, and does nothing
outside a state machine or for a temp with no slot. The store is a raw copy,
so the slot's single drop consumes the temp's +1.

Measured:
- `read_dir` on a 7-entry directory, 20 calls, fixed-allocator leak oracle:
  2,060 live blocks at exit → 1,080 (constructor sites) → **0** (call and
  method sites).
- A struct literal carrying a Dispose-counted value, pushed in an `io.async`
  loop after an await: 0 of 3 disposed → 3 of 3.

## Tests

`tests/async_loop_buffer_await.test.yo`, "a struct-literal call argument in an
async loop is released with its list": three values pushed across awaits, each
disposed exactly once when the list dies. Fails on develop (0 disposed).
