# The site generator kept a plain `dyn(v)` of a `String`, which S3b-`Dyn` rejects, so the docs job fails

**Severity:** S3 — CI plumbing: the "Documentation website (build only, no deploy)" job on develop `b2155b8bf` failed
with E0620, and the release workflow's site build would fail the same way.

**Status:** FIXED on `fix/develop-v0279-reds`.

## Symptom

```text
error[E0620]: `dyn(v)` erases a pointer, and its argument is a `String` value: the value is moved behind the pointer that owns it, and that pointer is spelled.
    --> scripts/build_site.yo:619:17
619 |       exn.throw(dyn(`build-site: cannot determine cwd: ${e}`));
```

## Root cause

#1981 (decision 49 S3b-`Dyn`) deleted the plain `dyn(v)` alias and swept `src/`, `std/` and `tests/`. `scripts/` was not
swept: `scripts/build_site.yo` threw three plain `dyn(<template literal>)` values (lines 619, 735, 759). The workflows
compile that script with the tree's stage 1 (`test.yml`, `deploy-site.yml`) and with the seed (`release.yml`).

## Fix

The three sites spell `dyn(Box.new(…))`, which both the tree and the v0.2.78 seed accept (`yo check
scripts/build_site.yo --std-path ./std` is clean under both). No other `.yo` file outside `src/`, `std/`, `tests/` and
`issues/repros/` spells a plain `dyn(v)`. `scripts/bench/async-vs-libuv/*.yo` fail `check` for unrelated move rules;
no workflow compiles them.
