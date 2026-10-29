# V2c left an implicit handle copy in a CI repro and in E0901's own good example

**Severity:** S2. Two of develop's required jobs failed on every run after #1663: the self-hosted tier-1 gates and internal shard 5. The compiler itself was correct; the inputs those jobs check still copied a handle implicitly.

**Found:** 2026-10-30, develop battery 40905885640 on `b8f86ebe2` (#1663, V2c).

**Fixed:** `fix/develop-v2c-battery`.

## Symptom

Tier-1 GATE 0 (`scripts/bootstrap/gates_fast.sh`) compiles `issues/repros/arc-spawn-capture-split.yo`:

```text
FAIL: repro arc-spawn-capture-split compile_rc=1
error[E0901]: use of moved value: `shared`
   --> issues/repros/arc-spawn-capture-split.yo:27:30
```

`tests/internal/diagnostics_registry_examples.test.yo`:

```text
✗ every registry example reproduces its code, and every good example loads clean
  E0901: the good example must load clean, got "E0901"
```

## Root cause

V2c (decision 17) makes an implicit copy of an `Rc`/`Arc` handle whose source is used again E0901. Its `yo fix --migrate rc-clone` sweep covered `std/`, `src/` and `tests/`, but two inputs live elsewhere:

- `issues/repros/arc-spawn-capture-split.yo` is compiled by tier-1 GATE 0. Each `Thread.spawn` closure captured `shared` implicitly, so the capture moved the handle, and the later `shared.*` read a moved value.
- Registry examples in `src/diagnostics_registry.yo` are string literals, which the sweep does not rewrite. Two entries copied a handle implicitly: E0901's own GOOD example (`_y := x; _take(x);` on an `Rc(i32)`), and both E0919 examples (`other := count;` on a module-level `Rc`). E0919's BAD example therefore reported E0901 before reaching its own code.

## Fix

- The repro's two closures capture an explicit clone: `Thread(unit).spawn({ shared : Arc.clone(shared) }(io : Io) => { ... })`. It still prints `p1 42` then `p2 7`, and it still exercises its subject: two same-signature closures passed to one generic function must mint distinct specializations.
- E0901's good example reads `_y := Rc.clone(x);`, the spelling the error's own help names, and both E0919 examples read `other := Rc.clone(count);`. A sweep of every `yo explain` example with the V2c binary found no other entry affected: every bad example reproduces its code, and every good example loads clean, apart from the toolchain band the test exempts and E0905, which fires in codegen.

## Regression test

The two CI gates are the tests: tier-1 GATE 0 compiles the repro, and `tests/internal/diagnostics_registry_examples.test.yo` loads every good example. Both failed on `b8f86ebe2` and pass on the fix branch.
