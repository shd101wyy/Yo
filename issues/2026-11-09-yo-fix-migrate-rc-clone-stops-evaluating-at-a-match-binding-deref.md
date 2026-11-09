# `yo fix --migrate rc-clone` stops evaluating at a match binding's `r.*`

**Severity:** S2 — a migration tool regresses. `yo fix --migrate rc-clone` reports that the file "does not evaluate" and
inserts 7 of its 19 clones, and the cli cases `fix-migrate-rc-clone` and `fix-migrate-rc-pattern` are GOLDEN-DIFF on
develop.

Found 2026-11-09 by the P3 lane's Tier 1 cli-diff run. It is not P3's: the develop binary at 68d531aec gives the same two
GOLDEN-DIFFs (`YO_SELF_BIN=<develop 68d531aec> bash scripts/cli-diff-test.sh fix-migrate-rc-clone fix-migrate-rc-pattern`),
and both cases passed with a binary built on beefabda4. The window is #1835 (N3 deref Generation A') and #1836 (O-3).

## Reproducer

`tests/cli-cases/fix-migrate-rc-clone`: `yo fix main.yo --migrate rc-clone` on its fixture.

```
golden:
fix: main.yo:96:12: `bare` holds a counted handle and its type `Bare` is not `Clone`; give the type `derive(..., Clone)` and spell `.clone()` by hand
fix: inserted 19 clone(s) and 2 capture list(s) and 1 `&` before a `match` scrutinee; 1 site(s) left as written (listed above); 0 file(s) did not evaluate
run (develop 68d531aec):
fix: main.yo does not evaluate; its copies are migrated only as far as evaluation reached
fix: main.yo:71:24: the source text does not print as `r`; left as written
fix: inserted 7 clone(s) and 0 capture list(s) and 1 `&` before a `match` scrutinee; 1 site(s) left as written (listed above); 1 file(s) did not evaluate
```

`main.yo:71` is `sum = (sum + r.*);` inside `match(h, .Some(r) => …)` over an `Option(Rc(i32))` parameter `h`.

**Closed by:** the v0.2.77 retirement PR, which removes `--migrate rc-clone` and `--migrate rc-pattern` with their cli
cases. This doc moves to `issues/retired/` when it lands; neither migration is fixed in the meantime.

## Root cause

Traced by the coordinator to #1835 (Generation A'): under the new deref meaning, the old-spelling fixtures stop
evaluating partway through. A written `r.*` on a reference binding now reads as the reference's own deref "whatever the referent", so this match
binding's `r.*` no longer reads the way the rc-clone walk expects. The text check ("does not print as `r`") rejects the
site, and evaluation stops.
