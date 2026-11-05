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

- **E0926.** `_check_reference_argument` (`src/evaluator/calls/helper.yo`) passes kind 4 to `reject_reference_without_deref` (`src/evaluator/utils.yo`) when a reference reaches a by-value parameter and its referent `type_requires_explicit_copy`. Kind 4's message says that `r.*` would copy the referent, and names how the referent's type copies (move-only, or a counted handle copied explicitly). The help offers two repairs: take the parameter as `&T` and pass `r`, or pass `r.*.clone()`. The clone is omitted when the type has no `Clone`. A `Copy` referent keeps the "write `r.*`" text.
- **`--migrate deref`.** Kind 4 records an `edit` 4 `DerefSite` (`src/expr_info.yo`). `_run_migrate_deref` (`src/main.yo`) lists the site (`fix: <at>: … left as written`), counts it as skipped and leaves the source unchanged. It still inserts `.*` where the referent is `Copy`.
- **E0901 after `.*`.** `transfer_explicit_copy_value` recognizes an `r.*` deref site on a reference binding and throws `_throw_reference_deref_copy`. That message names `r.*`, explains that the value stays with its owner, and offers the two repairs above instead of "take the parameter by value".

Tests: two `comptime_expect_error` cases in `tests/local_borrows.test.yo` (the E0926 text, and the E0901 text after `.*`), and the cli-case `tests/cli-cases/fix-migrate-deref-lists-a-move-only-by-value-argument`. It runs `fix . --migrate deref` and then `check` on a file with one move-only and one `Copy` by-value argument: the `Copy` site gains `.*`, and the `String` site is listed and kept, then reported as E0926.
