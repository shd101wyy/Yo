# An effect-handler local moved out after a conditional `unwind` leaks on the unwind path

**Severity:** S3 — a silent RC leak per unwind: a local of an effect-handler body that is later moved into an `own` argument is never released when a conditional `unwind` fires first

**Found**: 2026-10-04, while gating the M3 early-return-drop hoist
(`issues/yo-self-compile-performance-rc-string-eq.md`, "Negative result
2026-10-04" section) with an unwind-shaped probe. The hoist is
emission-neutral (the C below is byte-identical with and without it) — the
leak is pre-existing on both sides.

## Symptom

`tmp/m3probe.yo` (kept shape below), run with a current tree binary:

```rust
{ Exception } :: import("std/error");

(g_disposed : i32) = i32(0);
M3Res :: ref(struct(tag : i32));
impl(M3Res, Dispose(dispose : (fn(self : Self) -> unit)({
  g_disposed = (g_disposed + i32(1));
})));
take_own :: (fn(own(v) : M3Res) -> i32)(v.tag);
(g_trigger : i32) = i32(0);

do_trigger :: (fn(k : i32, exn : Exception) -> i32)({
  if((k == i32(0)), {
    exn.throw(dyn(`boom`));
  });
  i32(0)
});
shape_c :: (fn(k : i32) -> i32)({
  handler := Exception(
    throw : (
      (err) -> {
        s := M3Res(tag : i32(5));
        if((g_trigger == i32(0)), {
          unwind(i32(99));
        });
        r := take_own(s);
        ()
      }
    )
  );
  g_trigger = k;
  do_trigger(k, handler)
});
```

Observed: `shape_c(0)` unwinds correctly (returns 99) but `g_disposed` counts
only the four releases of the return-shaped siblings — the handler's `s`
(tag 5) is never disposed. Emitted C (`--emit-c-to`), handler body:

```c
__yo_t_...* __yo_v_s = __yo_new_...(5);
if (g_trigger == 0) {
  __yo_unwind_target = ...ULL;
  __yo_effect_escaped = 1;
  { int32_t _unw_val = 99; memcpy(__yo_unwind_value, &_unw_val, sizeof(int32_t)); }
  return (void*){0};          // ← NO __yo_decr_rc(__yo_v_s) on this path
}
...
int32_t ... = take_own((__yo_t_...*)(__yo_v_s));   // fallthrough consumes + releases
```

The fallthrough path releases `s` through the `own` transfer; the unwind path
releases nothing.

## Why this is a defect, not design

`begin.yo`'s M3 driver exists exactly for this shape — the comment above
`consumed_escape_drops` enumerates the exit kinds: the scope-end scheduler
skips CONSUMED vars, "return/unwind nodes" are covered by the
early-return-only drop attachments, and effect ESCAPES by
`consumed_variable_drop_expressions`. A `return` hidden in an `if` in a plain
fn body DOES get the drop (the same probe's `shape_a`, verified in the same
emitted C). Only the handler-body + `unwind` combination misses it.

## Root cause (unverified hypothesis, for whoever fixes it)

The M3 eligibility/attachment path (`_collect_early_return_cleanup_nodes` +
`_attach_if_cleanup_needs_drop` after the 2026-10-04 hoist;
`_attach_early_return_only_drop_to_returns` before it) one of:

- `s` is not marked `consumed_at_token` inside a handler-body begin block
  (the own-arg transfer may not record on closure-body statements), so the
  driver's `eligible` gate skips it; or
- the walker reaches the `unwind` node but `_attach_if_cleanup_needs_drop`
  bails — the unwind node's recorded `ei.env` snapshot not containing `s`,
  or the `_m3_token_*` position checks failing through the desugared
  `cond`-arm + handler-lambda chain.

Not yet diagnosed to the line; the repro above (plus `main` calling
`shape_c(0)`/`shape_c(1)` and printing `g_disposed`) is the discriminator:
after a fix, `g_disposed` gains one on the `shape_c(0)` path and the emitted
unwind arm carries `__yo_decr_rc(__yo_v_s)` before the `return`.

## Workaround

Do not move a handler-body local out after a conditional `unwind`; restructure
so the local is released on every path explicitly (or the unwind is the
handler's last act).
