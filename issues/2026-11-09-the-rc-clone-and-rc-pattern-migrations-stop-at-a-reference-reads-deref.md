# The rc-clone and rc-pattern migrations stop where a reference's read became `r.*`

**Severity:** S3. `yo fix --migrate rc-clone` and `--migrate rc-pattern` migrate only part of a file and exit 1. Their CLI goldens (`tests/cli-cases/fix-migrate-rc-clone`, `fix-migrate-rc-pattern`) differ on every tree binary built from develop at or after `68d531aec`. No compiled program changes.

Filed 2026-11-09 by the G2 lane. A binary built from develop `beefabda4` (plus the impl-origin branch) passes both cases against the same tree. Binaries built from `68d531aec` with either G2 branch (impl-origin, or the holders) fail both, and neither branch touches the migrations. The window is #1835 (N3 deref Generation A', every written `r.*` on a reference binding read as the deref) and #1836 (O-3).

## Reproducer

```sh
cp tests/cli-cases/fix-migrate-rc-clone/fixture/main.yo /tmp/fx/main.yo
yo fix /tmp/fx/main.yo --migrate rc-clone
```

```text
yo: error: fix: 1 file(s) do not evaluate — run `yo check` on them; their unevaluated copies were not migrated
fix: main.yo does not evaluate; its copies are migrated only as far as evaluation reached
fix: main.yo:71:24: the source text does not print as `r`; left as written
fix: inserted 7 clone(s) and 0 capture list(s) and 1 `&` before a `match` scrutinee; 1 site(s) left as written (listed above); 1 file(s) did not evaluate
```

The golden expects 19 clones, 2 capture lists, 0 files that did not evaluate, and rc 0. `yo check` on the half-migrated file stops at the first copy of a handle read through a reference:

```text
error[E0901]: use of moved value: cannot copy `r.*`, whose type `Rc(i32)` is a counted handle, copied only explicitly (`Rc.clone(h)`): `r` is a reference, and the value it refers to stays with its owner.
```

## Where to look

The migration finds its sites by evaluating the file and rewriting each copy it records. A read of a reference binding now evaluates as `r.*`. That E0901 aborts the file instead of being recorded as a site, and the site's source text `r` no longer prints as the recorded expression `r.*` ("does not print as `r`; left as written").
