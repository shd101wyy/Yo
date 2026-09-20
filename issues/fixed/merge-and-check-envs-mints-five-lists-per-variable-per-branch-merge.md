# `merge_and_check_envs` mints five `ArrayList`s per variable per frame on EVERY `cond`/`match` — 13% of all constructions in a self-check

**Status: FIXED 2026-09-20 (census-verified before and after).**

Found by the Perceus reuse census (`plans/archive/PERCEUS_REUSE.md` §0,
`scripts/bootstrap/reuse_census_t.py`): of the 918 M constructions that a
same-function death could in principle pair with, **340 M (37%) are in one
function**, `merge_and_check_envs` (`src/evaluator/utils.yo:1055`).

## Measurement

`check src/main.yo --std-path ./std`, tree `7eada73f8`, instrumented
emission: gross constructions 2,633 M. Attributed to `merge_and_check_envs`
(births in its callees returned to it, i.e. the `.new()` calls in its body):

| type                        | constructions | dies in the same activation |
| --------------------------- | ------------- | --------------------------- |
| `ArrayList(Option(Token))`  | 127.6 M       | 127.6 M (100%)              |
| `ArrayList(String)`         | ~160 M        | ~160 M                      |
| `ArrayList(TypeValue)`      | (part of 155 M) |                           |
| `ArrayList(usize)`          | (part of 109 M) |                           |

`ArrayList(Option(Token))` is constructed NOWHERE else in the compiler, so
its 127.6 M is exactly 3 lists × 42.5 M (variable, frame, merge) visits.

## Mechanism

The function is called for every evaluated `cond`/`match` (branch-state
merge). For each frame of the env (`0..max_frame_level`) and each variable of
that frame it allocates five fresh lists, fills them with one entry per
case env, reads them once, and lets them die at the end of the iteration:

```rust
while(var_j < frame.variables.len(), {
  ...
  initialized_at_tokens := ArrayList(Option(Token)).new();
  consumed_at_tokens := ArrayList(Option(Token)).new();
  owning_at_tokens := ArrayList(Option(Token)).new();
  var_ids := ArrayList(usize).new();
  case_types := ArrayList(TypeValue).new();
  // + cb_tys / cb_caps / cb_body_idx in the cross-branch block below
```

The env has every enclosing frame — module globals, the prelude's, the
function's params and locals — so a `match` deep in a big function walks
thousands of variables, and the whole walk repeats for every `cond`/`match`
evaluated in that scope (and again per specialization). Each list is
`ArrayList.new()` (one 40–80 B RC cell) plus its backing buffer on the first
push: ~10 mallocs per variable visit, all dead before the next iteration.

This is precisely the shape Perceus would have reused automatically — and
the reason the plan's measurement says the hand edit is worth more than the
mechanism: one edit removes ≈13% of every construction in a self-check.

## Fix (applied)

Hoist the eight lists above the `var_j` loop (and the `frame_i` loop; their
element types do not depend on the frame) and `clear()` them at the top of
each iteration; `ArrayList.clear` keeps the buffer. The lists never escape
the iteration (they are read by index inside it), so the change is
behaviour-preserving and the emitted C for everything else is unchanged.
Measure with the census (`ArrayList(Option(Token))` gross must fall from
127.6 M to ~0) and the wall of `check src/main.yo`.

## Verification

Same census, same source tree (`perceus-base`, tree `e32207097`), compiler
built from the fixed source:

| metric                                   | before   | after     |
| ---------------------------------------- | -------- | --------- |
| gross constructions                      | 2,633 M  | 2,275 M   |
| `ArrayList(Option(Token))` constructions | 127.6 M  | **104 k** |
| `ArrayList(TypeValue)` constructions     | 168.4 M  | 83.4 M    |
| `ArrayList(usize)` constructions         | 175.8 M  | 91.0 M    |
| `merge_and_check_envs` in the top-20 functions by pairable births | 340 M (1st) | absent |

(`ArrayList(String)` is unchanged at 173 M: those lists are minted
elsewhere — the census attributed them to this function only through its
callees' return values, see the plan's §0.2 caveat on transitive attribution.)
Wall of `check src/main.yo` for the three evaluator fixes together (this one,
`_was_self_bound`, `lookup_enum_cfid`): 350.5 s → 315.3 s, user 292.9 s →
254.4 s, footprint unchanged (31.5 GB) — same-tree A/B, tree-built binaries.
