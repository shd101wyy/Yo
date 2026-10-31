# `check ./src` and `compile src/main.yo` fail machine-wide through the markdown-yo dependency

*Filed 2026-11-01 by B4-2 (VBD v0.2.74 campaign, r3 regeneration).*

**Severity:** S1 — every `yo check ./src` / `yo compile src/main.yo` on this box fails
through the pinned `markdown-yo` dependency, with every compiler binary tested (the
published seed v0.2.73, develop `8866e5f0d`, and the B4-2 r3 heads). No B4-2 code is
involved: the same failure reproduces with the unmodified develop binary on the
unmodified develop tree.

## What was observed

Starting some time between 04:29 and 04:52 on 2026-11-01 (a `check ./src` at 04:29 with
the same binary in the same worktree passed 276/276), every evaluation whose import chain
reaches the dependency fails:

```
error[E0610]: No method "clone" on Reference: the type has no field or method with that name.
    --> ~/.cache/yo/store/sha256/0f767e63.../src/inline/link.yo:841:48
841 |   (maybe_ref : Option(Reference)) = state.*.env.references.get_cloned(&label);
note: raised here, inside the standard library
    --> std/collections/hash_map.yo:929: `.Some(index) => .Some((Self._data_ptr(self).add(index)).*.value.clone())`
```

`check ./src` reports 270/276 (the 6 failing files are those whose chain imports
`src/doc_command.yo` / `src/manifest.yo` / `src/diagnostics_registry.yo`, the importers of
`markdown-yo`); `compile src/main.yo --emit-c` fails outright. 12 E0610 occurrences per
run; deterministic across three consecutive runs and across worktrees.

`Reference :: struct(href : String, title : String)` (`src/types.yo:206` of the pinned
`markdown-yo` v0.0.22, integrity `sha256-0f767e63…`) carries no `derive(…, Clone)`, so
`HashMap(String, Reference).get_cloned` requires `.clone()` to resolve for `Reference`
without user-visible evidence — the auto/structural clone path.

## What is established

- Reproduces with: the published seed `yo` v0.2.73; `yo-base4` (develop `8866e5f0d` built
  by the seed); the B4-2 r3 PR-1 head binary. Always 270/276, same error.
- Independent of B4-2: same result on the unmodified develop tree.
- The store entry `0f767e63…` was MISSING from `~/.cache/yo/store` at ~05:10 (another
  agent's cache churn is the likely cause — the store is machine-shared); `yo install
  --locked` restored the bytes ("Done"), but evaluation still fails afterwards.
- All `check ./src` / emit gates that ran BEFORE ~04:30 today passed (B4-2 r2's full gate
  suite yesterday; B4-2 r3's PR-1 gate at 04:29, including EMITDIFF=IDENTICAL).

## What is NOT established

- Whether the trigger is (a) the restored store content differing from what the cache
  served before it vanished, (b) a resolution fallback to `~/.cache/yo/git/` serving
  different bytes, or (c) a genuine std/prelude change on develop (#1699/#1700 touched
  `std/prelude.yo` heavily) that only now gets exercised because the warm cache that
  satisfied `.clone()` for `Reference` is gone. The seed failing with develop's
  `--std-path ./std` is consistent with (c) but does not prove it (the seed never
  evaluated this dep cold against this std before).

## Reproducer

```
cd <any checkout at 8866e5f0d with submodules>
yo check ./src --std-path ./std        # 270/276, E0610 above
```

## Impact on B4-2 r3

The PR-2 head gates (`check ./src`, the emit-diff, `tests/internal/compile.test.yo`)
cannot run until this is resolved. PR-1's full r3 gate suite completed before the window
(build rc=0, `check ./src` 276/276 at 04:29, EMITDIFF=IDENTICAL, `check ./std` 171/171,
corpus 45/45 IDENTICAL with 0 compile failures). `check ./std` and the corpus do not
import the dependency and still pass.
