# A clean develop tip cannot raw-compile `src/main.yo`: E0610 `No method "clone" on Reference` through the `inline` dependency

**Severity:** S2 (a documented workflow fails on a clean develop tip: AGENTS.md's `yo compile src/main.yo --skip-c-compiler`; the `yo build` and `yo test` paths are unaffected on develop itself, but the failure also surfaces through `yo build` on trees that shift comptime evaluation order, e.g. the decision 43 step 2 layers).

Discovered 2026-10-31 while re-gating the decision 43 step 2 stack against develop `8866e5f0d` (#1703 ast-immutable + #1702 `find_methods_from_generic_impls` cache).

## Reproducer

Any checkout at `8866e5f0d` or later (verified in a detached worktree with no local changes):

```bash
yo compile src/main.yo --std-path ./std --skip-c-compiler --emit-c-to /tmp/probe.c
```

```text
error[E0610]: No method "clone" on Reference: the type has no field or method with that name.
    --> ~/.cache/yo/store/sha256/0f767e63487753442dd53d7106d4bc65e4721885080b560a295815f5931e8fdd/src/inline/link.yo:841:48
    |
841 |         (maybe_ref : Option(Reference)) = state.*.env.references.get_cloned(&label);
    |                                                ^
note: raised here, inside the standard library
    --> std/collections/hash_map.yo:929:62
929 |       .Some(index) => .Some((Self._data_ptr(self).add(index)).*.value.clone()),
```

rc=1, deterministic (rerun identical). The `inline` dependency is content-locked (`yo.lock` unchanged across the window), so the store copy is the same code that compiled before.

## What changed

- develop `8de7b4f02` (#1700): the same command succeeds (rc=0, `emitmain_base8`).
- develop `8866e5f0d` (#1702 + #1703): the command fails as above, while `yo build --std-path ./std` still succeeds (rc=0) — the raw `compile` path evaluates the `inline` dep's comptime closure and the build path does not reach it the same way.
- develop `8866e5f0d` + the decision 43 step 2 N1b layer: `yo build` still rc=0.
- develop `8866e5f0d` + N1b + N1c-1 (`vbd/d43-step2-n1c-p1703`, fold verified: its tree differs from the passing `-p1700` tree by exactly develop's `8de7b4f02..8866e5f0d` diff): `yo build` now fails with the SAME error at the same site — the layer's evaluation-order shift exposes the same broken resolution inside the build path.

So the regression window is #1702 (the `find_methods_from_generic_impls` cache, keyed on resolved receiver + method name + trait-impl epoch + registration owner) or #1703 (the id-keyed AST rewrite table); the `Reference.clone` resolution that `HashMap(String, Reference).get_cloned` relies on is order-sensitive after them. The bug reproduces with no decision-43 code in the compiler at all (the raw `compile` on clean develop).

## Fix direction

Not investigated here (discovered during stack gating; filed per the every-bug-gets-a-doc rule). First probe: `YO_DEBUG_*` or a bisect of #1702 vs #1703 on the reproducer; second: check whether the method-lookup cache returns a pre-`derive(Clone)` registration snapshot for `Reference`'s owner module when the dep's comptime evaluation re-enters the registry.
