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

## Fix

Fixed on 2026-11-05 (`vbd/d43-dead-arm`). `yo fix --migrate deref` now evaluates every arm, each under a target for which it is live:

- While the migration records, `evaluate_cond` (`src/evaluator/exprs/cond.yo`) notes each file in which a compile-time-known condition left an arm unevaluated. That covers a compile-time-false arm and every arm after a compile-time-true one.
- Those files are evaluated again for every other (architecture, OS) pair of the supported targets (`comptime_distinct_targets`, `src/target.yo`). Each evaluation runs in a child process, `yo fix <files> --migrate deref --target T`, because an in-process re-evaluation is not a clean reset. The child writes its sites to the file named by `YO_FIX_DEREF_SITES_OUT` and applies nothing. The compile-time target queries (`__yo_process_arch`, `__yo_process_platform`, `__yo_pointer_size_bits`) read only the architecture and the OS, so the ABI does not matter.
- The parent merges the sites and applies them once. The result does not depend on the host.
- When targets read one position differently, the position is listed and left as written. The difference can be an edit on one target against a name another target judged and read as written (`record_deref_clean_site`), or two different edits. No single spelling is right for every target in that case.
- An explicit `--target` still evaluates for that target alone.

A syntactic rewrite of the dead arms was rejected. E0926's exemptions depend on types: an auto-deref receiver, a lend to a `&` slot, a re-point, and the payload `.*` through a `Box`/`Rc`. A pass without types would mis-edit them.

`yo check` still reports E0926 only for the target it evaluates for. It does the same for every other diagnostic in a compile-time-dead arm, and CI's per-architecture shards check the other arms.

Tests: two cli cases.

- `tests/cli-cases/fix-migrate-deref-dead-arm` migrates all three arms of a `cond(arch == …)` on any host. Before the fix, only the live arm was migrated.
- `tests/cli-cases/fix-migrate-deref-targets-disagree` covers a `pick(n)` that is a lend on one target and a whole-value read on another. It is listed and left as written.
