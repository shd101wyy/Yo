# A mutated store entry is reused by `yo install --locked` — the `.verified` marker made the reuse path skip re-hashing forever

**Severity:** S1 — trust of output. The content-addressed store is machine-global shared state; once any process writes into a landed entry, every project on the machine silently compiles the mutated bytes as if they were the content `yo.lock` names. No diagnostic fires — the corruption surfaces (if at all) as unrelated evaluation errors in whichever project trips over the changed code, while others keep building the wrong dependency without a signal.

**Status:** FIXED 2026-11-01 (fix/develop-store-integrity): the locked reuse path re-hashes the stored tree on every install and re-fetches it on mismatch.

## Symptom

A clean develop tip (8866e5f0d..f9c9ba172) failed `yo compile src/main.yo --std-path ./std --skip-c-compiler` with a deterministic E0610 `No method "clone" on Reference` at the markdown-yo dependency's `inline/link.yo:841` through `hash_map.yo:929` (the E0610 `No method "clone" on Reference` issue the window was first blamed for). The compiler was innocent: at 04:47 on 2026-11-01 an accessor-migration tool run by an agent had written into the PRESENT store entry `~/.cache/yo/store/sha256/0f767e63…/src/inline/link.yo` (`.references.get(&label)` → `.get_cloned(&label)`), and `get_cloned` requires `V <: Clone`, which markdown-yo's `Reference` (no `derive(Clone)`) does not satisfy. The seed and pure develop failed identically against the same store.

The b4-2 agent observed the reuse-side hole in the same window: after restoring the file's bytes by hand, evaluation still disagreed — "restores bytes but not evaluation" — because other entry state (mtimes at minimum) kept disagreeing with a re-derived cache. The store is not write-verified at reuse time at all.

## Root cause

`fetch_package`'s locked fast path (src/fetch.yo) trusted a `.verified` marker SIBLING file: a tree landed by a full hash match wrote `<tree dir>.verified`, and every later reuse skipped `compute_content_hash` when the marker existed (`verified = marked`). The marker documents the tree's state at LANDING time only. A write into an inner file afterwards — an agent's sweep tool, an editor, a stray script — leaves the marker standing, so `yo install --locked` (the reproducibility path!) reuses the mutated tree indefinitely. The re-fetch machinery (remove + re-extract from the local mirror, which also repairs offline) existed but was reachable only when the marker was missing.

## Fix

`src/fetch.yo` `fetch_package`: the reuse path now runs `compute_content_hash` on EVERY reuse; on a mismatch it prints `the stored tree <hash> does not hash to its name — re-fetching`, removes the tree and falls through to the existing slow path (local mirror → extract → hash → land), so the pristine bytes are restored automatically. The marker is still written after a matching hash but no longer grants trust; its doc comment (and `fetch_package`'s) say so. `src/cache.yo`'s `store_verified_marker` comment updated to "informational".

Cost: one sha256 pass over each dependency tree per `yo install`. The trees are source-sized; an install already does far more IO fetching and extracting.

## Test

`tests/internal/fetch.test.yo` "fetch_package: a mutated inner file of a stored tree is detected and the tree re-fetched": builds a one-file git repo in `temp_dir()`, lands it through `fetch_package`, reuses it through the locked path, MUTATES `<tree dir>/lib.yo`, fetches again, and asserts the pristine content is back. Fails before the fix (the mutated `9.9.9` survives the reuse), passes after.

## Follow-ups (not this fix)

- `yo cache verify` (walk the store, report mismatched entries) and making landed trees read-only on disk are the harder bars; file separately if wanted.
- The tool that wrote into the store is its own bug: `issues/2026-11-01-a-sweep-tool-wrote-into-the-content-addressed-store.md`.
