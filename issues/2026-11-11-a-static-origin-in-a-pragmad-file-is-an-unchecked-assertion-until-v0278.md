# A `static` origin in std or a pragma'd file is an unchecked assertion until v0.2.78

**Severity:** S2. In std and in a file that declares `pragma(Pragma.AllowUnsafe);`, a reference typed over the empty
origin `static` (or a union holding it, or the empty union `()`) still accepts any reference and freezes nothing.
A pragma'd module can also export a `static`-typed alias or signature to a safe importer, which then uses it
unchecked. The blast radius is bounded: std spells no `static` today, every `src/` file is pragma'd, and safe code
cannot spell it (E0922).

Filed 2026-11-11 under `~/Workspace/Yo-wt/v0273/fable/VERDICTS-57.md` §1.2, as the residue of the v0.2.77 wall that
`issues/fixed/2026-11-11-a-reference-typed-over-the-static-origin-accepts-any-reference-and-freezes-nothing.md`
puts up. That hole was found by the borrow/ownership audit (yo-6c).

## What is unchecked

Decision 49 spells the empty origin `static`. The three spelling readers (`_origin_names_into`,
`_type_origin_names_into` and `_result_origin_names_into` in `src/evaluator/types/function.yo`) give it no name, so
it is `OriginSet(places : [], is_elided : false)`. Every consumer reads only the names. `bind_join` runs its subset
check only when the holder lists names. `fn_result_composite_origin_names` returns `.None` for zero names.
`_carries_origin_inner` makes a `static` reference `Escapable`. A `static` position therefore takes a reference to
any place and records no loan.

In v0.2.77 the readers raise E0922 for that spelling unless the file is a std module (`is_std_module_path`) or
unsafe-capable (`is_implicitly_unsafe_capable_file`). Those files keep the unchecked reading. A pragma'd program like
the audit program below still compiles and reads freed memory:

```yo
pragma(Pragma.AllowUnsafe);
{ String } :: import("std/string");
{ println } :: import("std/fmt");
X :: struct(s : String);
main :: (fn() -> unit)({
  b := Rc.new(X(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz")));
  o := Option(&(Rc(X), static)).Some(&b);
  drop(b);
  match(o, .Some(r) => println(`OUT: ${r.*.*.s.len().to_string()}`), .None => println("none"));
  ()
});
export(main);
```

Unread: whether a pragma'd module's `Option(&(X, static))` and a safe importer's `Option(&X)` share one memoized
type-constructor instance, which would hand the unchecked type to safe code without any spelling there.

## The rule (v0.2.78, with P12)

From VERDICTS-57 §1.4:

- `static` is "spelled, zero names" at every E0923 site: the subset check runs against an empty holder set.
- `o ⊆ static` holds only for `o = static`. It is checked where an expected type meets a reference value.
- The introduction forms are a literal, `&G` of an immutable module-level binding, and a `static`-typed value.

The first probe is the memo question above. Once the rule lands, the wall rows in `tests/origins/unsound/static-*.yo`
expect E0923 instead of E0922, and they join the corpus and the model (`tests/origins/corpus.tsv`).
