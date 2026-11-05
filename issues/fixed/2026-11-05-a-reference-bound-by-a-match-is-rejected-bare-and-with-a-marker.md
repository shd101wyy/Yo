# A reference bound by a `match` arm is rejected bare (E0914 says `&c`) and with the marker (E0926 says `&c.*`)

**Severity:** S2 — a valid program is rejected, and the two diagnostics send the user around a loop: passing a match-bound reference to a `&T` parameter bare is E0914 ("lend `c` with `&c`"); writing `&c` is E0926 ("borrowing the value it refers to is spelled `&c.*`", and its help adds that `f(c)` "passes it to a reference parameter"). Only `&c.*` compiles. `yo fix --migrate markers` does not record the site either.

Found by the README example-project rehearsal for v0.2.75. markdown_it_yo's `format` (`match(&url.*.protocol, .Some(p) => result.push_string(p), …)`) and its image renderer (`match(&tokens(i), Token(children : .Some(children)) => recur(result, children), …)`) both needed `&p.*` / `&children.*`. Present on develop d76eac577.

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array_list");
total :: (fn(xs : &ArrayList(i32)) -> usize)(xs.len());
through_param :: (fn(o : &Option(ArrayList(i32))) -> usize)(
  match(o, .Some(c) => total(c), .None => usize(0))
);
through_local :: (fn() -> usize)({
  o := Option(ArrayList(i32)).Some(ArrayList(i32).new());
  match(&o, .Some(c) => total(c), .None => usize(0))
});
export(through_param, through_local);
```

```text
error[E0914]: Parameter "xs" is a `&` borrow (`xs : &T`): lend `c` with `&c`. …
```

With `total(&c)`:

```text
error[E0926]: `c` is a reference (`&ArrayList(i32)`): borrowing the value it refers to is spelled `&c.*`
```

`total(&c.*)` compiles. Expected: `total(c)` compiles, as it does for a reference parameter (`f :: (fn(r : &ArrayList(i32)) -> usize)(total(r))` is accepted), and as E0926's own help says.

## Root cause

`check_call_site_borrow_marker` (src/evaluator/calls/helper.yo) exempts "a borrow binding passed whole", but `_marker_place_of` classifies a match-arm binding that holds a reference as a plain `.Place`. Since decision 43 step 2 (N1e-1), matching through a reference or a `&` scrutinee binds its payload as a reference, so the binding should be exempt exactly as a `&T` parameter is. The markers migration records only `.Place` sites through the same path, so it never sees this one.

## Recommendation

Classify a reference-typed match binding (`variable_is_reference_binding`) as a borrow binding in `_marker_place_of`, so that the bare argument is accepted. Make E0914's help consistent with E0926: never suggest `&r` for an `r` that is already a reference. Test with the two functions above, plus the struct-pattern form `match(&ts(i), T(c : .Some(c)) => total(c), _ => …)`.

## Fix

`_marker_place_of` (src/evaluator/calls/helper.yo) classifies a match binding
that borrows the part it binds (`is_borrow_match_binding`) as a borrow
binding. Passed whole to a `&T` parameter, it lends bare, as a `&T` parameter
does. E0914 no longer fires on it, so the help loop is gone. Test:
`tests/match_binding_lend.test.yo`, covering the two functions above and the
struct-pattern form over an element.
