# RESOLVED (commit 85480c76) — tests 155→163

Implemented demand-driven loading (module_loader.yo loading-registry +
main.yo `demand_load_module`/`_load_module_at_abs` + import.yo
`_build_module_val_from_env` export). +8 resolvable cycles now pass; the 4
remaining fixtures (circular_b, circular_error_a/b, circular_open_b) error
identically to TS (export requested before declared across the cycle — genuinely
unresolvable). 0 regressions / 0 SIGSEGV: yo-self 227/227, std 151/151.

---

# Circular-import support in the yo-self `check` loader (design)

## Status

Open — design + precise blocker identified. Affects the 12 `tests/circular_deps/`
fixtures + `tests/circular_import.test.yo` (12 of the 27 remaining `check ./tests`
failures). TS passes them standalone (`./yo-cli check tests/circular_deps/circular_a.yo`
→ OK); yo-self fails with `module not preloaded`.

## Why it fails today

`main.yo`'s `check` is **post-order pre-preload**: for the entry file it collects
imports and `preload_module_tree`s each — fully evaluating every dependency into
the module cache (`register_module` at the END), then evaluates the entry reading
the cache. For a true cycle A↔B this cannot work: post-order evaluates B's body
**before** A is registered, so B's `import A` hits `module not preloaded`.

Concretely, `check circular_a.yo`: preload(circular_b) → recurse preload(circular_a)
→ evaluate circular_a body → line 4 `import circular_b` → circular_b is the OUTER
in-progress preload, not yet registered → throw.

The fixtures are written to be cycle-resolvable: `circular_a` `export(NodeKind)`
on line 2, THEN `import circular_b` on line 4; `circular_b` imports `NodeKind`
from A and exports `Tree`. So a **demand-driven** loader that exposes A's
partial exports (NodeKind, exported before A imports B) to B would resolve it —
exactly what TS does.

## The blocker (why it's not a small fix)

`evaluate_anonymous_module_begin_exprs` (`evaluator/values/anonymous_module.yo`)
assembles the module's exports into `module_value` **only at the end** (line ~549).
There is NO incremental export registration. So when a circular importer needs
the in-progress module's partial exports, there is nothing to read yet.

A correct fix therefore needs THREE parts, all touching core loading (which
currently yields 378 passing files — high regression risk):

1. **Demand-driven loading**: stop pre-preloading in post-order; evaluate the
   entry/module body and resolve each `import` ON DEMAND (load+eval the
   dependency when its `import` is hit), with a "currently-loading" registry that
   returns the in-progress module for cycles instead of throwing.
2. **Partial exports during a cycle**: either (a) build `module_value`
   INCREMENTALLY as each `export(...)` runs, or (b) resolve a circular import
   against the in-progress module's live ENV (the exported names are variables in
   its env). Without this, a cycle import sees empty exports.
3. **Thread `io` / `exn` into the import resolver**: `ctx.load_module` is a plain
   `(path) -> LoadModuleResult` with no `io`/`exn`; on-demand loading must read +
   parse + evaluate the dependency. Options: module-level `g_loader_io` /
   `g_loader_std_path` globals set at check start + a local `exn` per on-demand
   load (mirroring `preload_module_tree`'s `local_exn`).

## Recommended approach (dedicated effort)

1. Add an in-progress registry (path → in-progress ModuleVal/env) alongside the
   existing cache; `load_module` returns it on a cycle hit.
2. Make `export(...)` register into the in-progress ModuleVal incrementally
   (smallest viable: append to a live exports list keyed by the module path), so
   a cycle import reads partial exports.
3. Replace the entry's post-order pre-preload with demand-driven `load_module`
   that, on a miss, loads+evaluates the dependency (via `g_loader_io` + local
   `exn`), registering the in-progress placeholder BEFORE evaluating its body.
4. ALWAYS validate with the per-file baseline-vs-fix diff across **yo-self (227),
   std (151), tests (155→167 target)** — revert on ANY regression or SIGSEGV.
   The 227/227 yo-self milestone must not regress.

## Note

Not attempted inline at the end of a long session because it rearchitects the
module loader (378 passing files at stake) with no localized path — unlike the
comptime-fn cache fix (e3936a98) which was a bounded 2-area change. This is the
right next focused effort for the test-suite gap.
