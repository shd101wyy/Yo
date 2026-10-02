# An earlier argument read after an await in a later argument is stale

**Severity:** S1. Silently wrong value: in an `io.async` body, a call whose later argument awaits reads an earlier argument's value from a C local the suspension left stale. `S(n : xs.len(), extra : e.await(f, e))` produced `n = 134763524394288` instead of `2`.

**Status: FIXED (2026-10-02).** It has been present since the single-pass lowering (#1018, v0.2.47): it reproduces under the v0.2.48 seed. A peer session found it when #1093's test "a later argument of the consuming call still reads a moved slot local" failed on `ubuntu-24.04-arm` CI. On x64 that test passed only because the stack slot happened to still hold the value.

## Symptom

```rust
io.async((e : Io) => {
  xs := ArrayList(i32).new();
  xs.push(i32(1));
  xs.push(i32(2));
  e.await(yield(e), e);
  Report(items : xs, n : xs.len(), extra : e.await(later(e), e))
})
```

`r.n` is garbage whenever `later` suspends. The emitted C stores `size_t _tmp = len(sm->var_xs);` before the suspension (`sm->state = 2; return;`) and reads `.n = _tmp` after `__yo_resume_2:`, from a frame that no longer holds it.

## Cause

The suspension analysis (`walk_expr_`, `src/evaluator/shared/suspension_analysis.yo`) captures variables by the atoms that name them. A minted temp has no atom; only an RC temp was captured, through the deferred drop that names it. So a plain value temp held for an earlier argument never got a task slot. Even a temp with a slot was read through its C local at the call, because the call's argument code is the temp's name.

## Fix

- **Analysis:** after the arguments of a call are walked, every earlier argument's temp is captured when a later argument added a suspension point (`_capture_argument_temp`, which also handles a labeled argument `name : v`). The temp then gets a task slot, and the existing temp-to-slot store fills it. Such temps are recorded in `g_arg_temps_across_suspension`.
- **Codegen:** `_generate_expr` (`src/codegen/exprs/generation.yo`) renders such a call's value as its temp's task slot (`_sm_arg_temp_read`, through `sm_temp_slot_of`), so the enclosing call reads what the store wrote. Every other temp's emission is unchanged.

Tests in `tests/async/sm_ownership.test.yo`:
- "an earlier argument's value survives a suspension in a later argument". The awaited task scrubs the stack after its yield, so the test fails regardless of frame layout: it failed on two runs under a develop-built stage 1 before the fix.
- "a later argument of the consuming call still reads a moved slot local", whose awaited task now scrubs too.
