# `yo fix` renames an unimported `String` to `ToString`: the std export index skips spread re-exports

**Severity:** S3

## Reproducer

`tmp/fixme.yo`:

```yo
{ ToString } :: import("std/fmt");
f :: (fn() -> String)(String.from("a"));
main :: (fn() -> unit)({
  _s := f();
});
export(main);
```

```text
$ yo check tmp/fixme.yo
error[E0401]: Variable "String" not found.
help: did you mean "ToString"?

$ yo fix tmp/fixme.yo --dry-run
fix: tmp/fixme.yo:2:15: rename to "ToString"
```

`yo fix` applies the rename. The result does not compile, because `String`
becomes `ToString`, a trait, used as a return type. The fix should be the
import `{ String } :: import("std/string");`. For comparison, an unimported
`HashMap` gets `help: … import it: { HashMap } :: import("std/collections/hash-map");`,
and the rename is withheld because there are two candidates.

Found 2026-11-24 while probing the F2 binary (lane deref-f2). The same code is
on develop.

## Root cause

`_index_std_dir` (`src/main.yo`) builds the name → module index that
`lookup_std_exporters` (`src/diagnostics.yo`) reads. It reads `export(...)`
lists as text. In a directory that has an `index.yo`, it reads only that
file (`if(has_index && (name != "index.yo"), { continue; })`).
`std/string/index.yo` re-exports its submodules by spread
(`export(...(_rune), ...(_string), ...(_string_builder))`):

- The spread entries are not expanded.
- Each entry is registered as the junk name `...(_rune`.
- `std/string/string.yo`'s own `export(String, …)` is never read.

So `String`, and every other name re-exported through a spread `index.yo`,
has no exporter. Because of that, E0401 keeps the did-you-mean rename as the
one machine-applicable repair. With an exporter, it would have withheld the
rename, since rename and import would be two candidates.

## Fix direction

- Expand a spread `...(_m)` in an `index.yo` export list to the export list of
  the module `_m :: import("./m.yo")` names, registered under the index's
  spec (`std/string`).
- Stop registering entries that are not identifiers.
- Test: a cli-case running `yo fix --dry-run` on the reproducer, whose golden
  shows the import repair rather than the rename.
