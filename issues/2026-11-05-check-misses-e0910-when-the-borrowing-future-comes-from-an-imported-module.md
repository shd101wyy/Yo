# `check` misses E0910 when the borrowing future comes from an imported module

**Severity:** S2 — `yo check` accepts a program that `yo compile` rejects. An `io.await` whose future borrows a place and whose bundle is not a place passes `check`, and so passes the LSP and `check ./src`, when the async function is defined in another module. The error shows up only in codegen (`compile`, `build`).

Found 2026-11-05 by V5 part B (the `ref`-declaration migration), on `vbd/v5-part-b` merged with develop `95209c9b5`, using the v0.2.74 seed with `--std-path ./std`.

## Symptom

On that tree, seed `check ./src --std-path ./std` passed (rc 0, 276/276 files). Then the stage-1 `yo build --std-path ./std` of the same tree failed:

```
error[E0910]: The effect bundle of this `io.await` is evaluated after its future is made, and the future borrows `options` until the await completes: a bundle that runs code could move, overwrite or lend `&mut` that place first. With a borrowing future the bundle must be a place (`io`, `self.io`) (plans/VALUES_BY_DEFAULT.md §3.13 A2).
      --> src/main.yo:11808:87
      |
11808 |   project_dir := io.await(init_project(InitOptions(dir : dir, name : name), io, exn), IoExn(io : io, exn : exn));
```

`init_project` (in `src/init.yo`) had become `io.async({ &options }(e : IoExn) => …)` over `options : &InitOptions` once `InitOptions` was a value. The branch then made it a `sink(...)` parameter, so the build no longer hits this. The checker gap remains.

## Reproducer

`issues/repros/2026-11-05-check-misses-e0910/`: `lib.yo` defines the borrowing async function, and `main.yo` awaits it with an inline bundle.

```yo ignore
// lib.yo
show :: (fn(options : &Opts, io : Io) -> Impl(Future(unit, IoExn)))(
  io.async({ &options }(e : IoExn) => {
    println(&options.name);
  })
);
// main.yo
run :: (fn(io : Io, exn : Exception) -> unit)({
  io.await(show(Opts(name : String.from("x")), io), IoExn(io : io, exn : exn));
});
```

```
$ yo check main.yo --std-path ./std
check: main.yo — evaluator OK
$ yo compile main.yo --skip-c-compiler --std-path ./std
error[E0910]: The effect bundle of this `io.await` is evaluated after its future is made, and the future borrows `options` …
  --> main.yo:6:53
```

When `show` is defined in the same file, `check` reports the E0910, whether `show` comes before or after its caller. Only the cross-module case slips through.

## Root cause (not yet confirmed)

The rule is enforced in the evaluator (`src/evaluator/calls/function.yo`, the "effect bundle of this `io.await`" diagnostic), so the gap is not a codegen-only rule like E0905. It most likely comes from how the evaluator learns that a callee's future borrows its parameters. A demand-loaded module evaluated under `check`, which gives each module its own `ExprInfo` table, either has not yet recorded the borrowing capture of `show` when the caller's `io.await` is checked, or records it where the caller's check does not look. Under `compile` the whole program shares one table. The next step is to compare `_register_borrowing_future` / `g_checked_future_calls` between the two drivers.

## Status

Open. The test (the two-module repro as a `check` expectation of E0910) lands with the fix.

A stage-1 compiler built from develop `79f5a2cc2` cannot run the repro as written. N1e's E0926 rejects `{ &options }` on a `&Opts` parameter outside the exempt `src/` tree. The seed and `src/` still accept that spelling.
