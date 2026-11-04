# `--migrate deref` and E0926 skip a platform-gated arm that is dead on the host

**Severity:** S3. A file the migration reports as clean can still fail E0926 on another target. Develop's arm64 shard went red this way once; the language itself is not wrong.

> Found 2026-11-04 on develop run 41823671930 (`c900b3fe6`, #1752 N1e-1): "test suite (ubuntu-24.04-arm) shard 0/4" failed `tests/parameter_modes_collisions.test.yo` with E0926, and every x86-64 job passed.

## Symptom

```
error[E0926]: `n` is a reference (`&mut i64`): reading the value it refers to is spelled `n.*`
9 | _pmc_asm_bump :: (fn(n : &mut(i64)) -> unit)(begin(cond((arch == (Arch.Aarch64)) => begin((v : i64) = n, ...
```

N1e-1's sweep ran on x86-64. It rewrote the `Arch.X86_64` arm of `_pmc_asm_bump` and left the `Arch.Aarch64` arm and the fallback arm unchanged.

## Reproducer

```yo ignore
bump :: (fn(n : &mut i64) -> unit)({
  cond(
    (arch == Arch.Aarch64) => { n = (n + i64(1)); },   // dead on x86-64: neither E0926 nor --migrate deref sees it
    true => { n.* = (n.* + i64(1)); }
  );
});
```

On an x86-64 host, `yo check` accepts the reproducer and `yo fix --migrate deref` leaves it unchanged. On aarch64, the first arm is E0926.

## Root cause

A `cond` whose condition is comptime-known evaluates only the live arm. The E0926 check and the deref migration both run inside evaluation, so they never visit a dead arm.

## Fix direction

The migration should rewrite every arm, comptime-dead arms included, for example with a syntactic pass over a dead arm's body that uses the function's declared reference parameters. A migration result must not depend on the host target.

Until then, sweep a platform-gated file by swapping its gates. Rewrite `Arch.Aarch64` ↔ `Arch.X86_64` in a copy and run `yo check --test-bodies` on it. Over `tests/` on 2026-11-04 this found only `tests/parameter_modes_collisions.test.yo`, fixed by `fix/develop-deref-dead-arms`.
