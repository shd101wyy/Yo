# `yo fix --migrate deref` rewrites `f(r)` to `f(r.*)` for a move-only referent and a by-value parameter, which is E0901

**Severity:** S3 — a migration produces code that does not compile, and the follow-up diagnostic points away from the fix: E0926's help says "write `r.*`", the migration writes it, and the result is E0901 ("cannot copy `r` … move it (`sink(r)`)"). The real choices are to borrow in the callee (`s : &String`) or to copy explicitly (`r.*.clone()`).

Found by the README example-project rehearsal for v0.2.75 (markdown_it_yo's `validate_link(url : &String)` called `_is_bad_protocol(url)`, which took `url : String`). Present on develop d76eac577.

## Reproducer

```yo
{ String } :: import("std/string");
take_len :: (fn(s : String) -> usize)(s.len());
f :: (fn(r : &String) -> usize)(take_len(r));
export(f);
```

```text
error[E0926]: `r` is a reference (`&String`): reading the value it refers to is spelled `r.*`
help: write `r.*`; `r.field`, `r.method()` and `r(i)` read through it, and `f(r)` passes it to a reference parameter (`yo fix --migrate deref` inserts the `.*`)
```

`yo fix d.yo --migrate deref` writes `take_len(r.*)`, and then:

```text
error[E0901]: use of moved value: cannot copy `r`, whose type `String` is move-only, and it cannot be moved either: it is borrowed (…). Take the parameter by value (`x : T`, without `&`) to own it.
help: `r` is move-only (…): move it (`sink(r)`), lend it to a `&mut T` parameter, or share it through a reference type (…)
```

## Recommendation

- E0926, where the read is a by-value use of a move-only referent: say that `r.*` would copy a move-only value, and offer `r.*.clone()` or changing the receiving parameter to `&T`. "write `r.*`" is right only for a `Copy` referent.
- `--migrate deref`: insert `.*` only where the referent's type is implicitly copyable. Otherwise leave the site as written and list it, as the migration already does for sites the targets disagree on.
- E0901 after `.*`: name the dereference (`r.*`), not the reference, and drop the "take the parameter by value" advice: the parameter is a reference on purpose.

## Fix

The three recommendations are implemented as follows:

- **E0926.** The identifier path judges a bare reference before its consumer is known, so it cannot tell a copy from a read. `r.*` of a move-only `String` is right as an operand (`r.* == o.*` compiles) and as the argument of a builtin that only reads it (`ref_count(c.*)`), and it is E0901 in a by-value parameter, a `:=` binding or a return. For a referent that is not implicitly copyable, `reject_reference_without_deref` (`src/evaluator/utils.yo`) keeps the message ("reading the value it refers to is spelled `r.*`") and its help names both cases: write `r.*` where the value is only read; where it would be copied, the type is move-only (or a counted handle), so read through `r` (a field, a method, a `&T` parameter `r` is passed to) or copy it explicitly with `r.*.clone()` (the clone is omitted when the type has no `Clone`). A `Copy` referent keeps the plain "write `r.*`" help.
- **`--migrate deref`.** The read is recorded as an `edit` 0 site as before. When the evaluation then copies that bare read (`transfer_explicit_copy_value` reaches it), `note_reference_read_copied` (`src/expr_info.yo`) marks its position, and `take_deref_sites` hands the site out as an `edit` 4. `_run_migrate_deref` (`src/main.yo`) lists an `edit` 4 site (`fix: <at>: `r` is copied here as a whole value, … left as written`), counts it as skipped and leaves the source unchanged. A read that is not copied keeps its `edit` 0 and gains `.*`.
- **E0901 after `.*`.** `transfer_explicit_copy_value` recognizes an `r.*` deref site on a reference binding and throws `_throw_reference_deref_copy`. That message names `r.*`, says the value stays with its owner, and offers reading through `r` or `r.*.clone()` instead of "take the parameter by value".

A first version decided the listing at the identifier from the referent's type alone (a kind 4 of E0926). That over-classified the reads that do not copy: `r == o` on `&String` was told that `r.*` would copy, and the migration left `ref_count(c)` unmigrated, which `tests/cli-cases/fix-migrate-rc-pattern` caught. The consumer now decides.

Tests: `tests/local_borrows.test.yo` has E0926 for a by-value argument, a `:=` binding and a `==` operand, the E0901 text after `.*`, and a run test of `r.* == o.*` on two `String` references. `tests/move_only.test.yo` and `tests/fn_once.test.yo` pin the new E0901 text at their `f.*`/`x.*` copies. The cli-case `tests/cli-cases/fix-migrate-deref-lists-a-move-only-by-value-argument` runs `fix . --migrate deref`. The `Copy` site in `b.yo` and the `==` operands in `d.yo` gain `.*`. The copied `String` sites, a by-value argument in `a.yo` and a `:=` binding in `c.yo`, are listed and kept. Each copied site has its own file because a file whose evaluation stops is migrated only up to that point. A kept site stops it: the unmigrated copy still raises E0901, so `fix` exits 1, and the harness runs no command after a failing one (E0926's text is pinned by `local_borrows` instead).
