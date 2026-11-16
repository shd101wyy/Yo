# A reference payload copied to a local in its arm is rejected: "the projection borrows no argument"

**Severity:** S2. A valid program is rejected in safe code. The workarounds are to use the binding directly or to
copy it with a type (`(t : &i32) = s`).

Found 2026-11-16 by the d49-str lane, while fixing the `str` case of the same shape
(`issues/fixed/2026-11-16-a-str-payload-binding-is-a-reference-to-an-unsized-place.md`).

## Reproducer

```yo
f :: (fn(o : Option(&i32), d : &i32) -> bool)({
  v := match(
    o,
    .Some(s) => {
      t := s;
      t
    },
    .None => d
  );
  true
});
export(f);
```

Measured on the flip's final tree binary (`vbd/d49-flip`, merged as #1970). The same error appears for a
`&(i32, static)` payload in a pragma'd file, and on `vbd/d49-str`:

```text
error: Cannot bind `t` to `s`: the projection borrows no argument, so its place has no storage to borrow.
  --> i.yo:3:10
```

## Root cause

`evaluate_match` (`src/evaluator/exprs/match.yo`) binds a reference payload as a reference binding. Inside the arm,
`t := s` binds `t` as a local borrow of what `s` borrows (R-TAIL, `_bind_projection_result`). That function collects
the chain's roots with `_chain_leaf_origins`. Here they are empty, so the binding is rejected:

- for a `static` payload, because it borrows nothing;
- for a payload of a by-value parameter `o : Option(&i32)`, because the parameter's holder roots are not collected
  for the chain.

The `str` case (a legacy `&(str, static)` view) is fixed on `vbd/d49-str` by binding the payload by value. That fix
does not cover a sized pointee: a by-value binding there changes how `s` reads (`s.*`), and the reference binding is
decision 43's shape.

## Options

1. `_bind_projection_result`'s chain arm takes a reference payload leaf's held roots (`_ref_payload_held_of`, the
   parameter's rigid origin) as its places, and binds with no loan when the chain's type has a `static` origin.
2. Bind `t := s` over a reference payload by value: the copy of a shared reference, as `(t : &i32) = s` does today.

Option 1 is preferred. It keeps R-TAIL's single rule for chains, and a copy made by option 2 would lose the loan
that freezes the scrutinee's referent while `t` lives.
