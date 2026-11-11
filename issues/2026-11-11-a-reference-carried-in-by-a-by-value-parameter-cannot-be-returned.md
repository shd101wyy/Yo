# A reference carried in by a by-value parameter cannot be returned

**Severity:** S2. A function that returns the reference a by-value parameter carries —
`o : Option(&(String, q))` matched as `.Some(s) => s` under `-> &(String, q)` — is rejected with E0912, "`s` binds
a reference out of `o`, which borrows none of them: its storage ends with the call". The reference points into the
CALLER's storage; only `o`'s own slot ends with the call. Sound `unwrap_or(o, default)`-shaped helpers over
`Option(&T)` or a holder cannot be written, spelled or elided. Not expressible on v0.2.76, which stops earlier with
E0926 (`s` must be read as `s.*`), a rule the R1 read rule has since replaced.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 C7). Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-a-reference-carried-in-by-a-by-value-parameter-cannot-be-returned.yo` (expects accept):

```yo
{ String } :: import("std/string");
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
unwrap_or_first :: (fn(generic(q : Origin), xs : &(ArrayList(String), q), o : Option(&(String, q))) -> &(String, q))(
  match(o, .Some(s) => s, .None => xs.index(usize(0)))
);
main :: (fn() -> unit)({
  mut(xs) := ArrayList(String).new();
  xs.push(String.from("hello-world-hello-world-hello-world"));
  r := unwrap_or_first(&xs, .None);
  println(`OUT: ${r.*}`);
  ()
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710
error[E0912]: A projection yields a place reached from one of its `&`/`&mut` parameters, and `s` binds a reference
out of `o`, which borrows none of them: its storage ends with the call (decision 24, the single-root rule).
 --> repro.yo:8:24
  |   match(o, .Some(s) => s, .None => xs.index(usize(0)))
$ yo check repro.yo        # v0.2.76: error[E0926]: `s` is a reference (`&String`): reading the value it refers to is spelled `s.*`
```

- `…-elided.yo` (expects accept): `inner :: (fn(o : Option(&String), d : &String) -> &String)(match(o, .Some(s) => s,
  .None => d))`; the same E0912.
- `…-neg.yo` (expects E0912, rejected today and after the fix): `o : Option(String)` OWNS its payload and the body
  returns `s` out of `match(&o, …)`, a place inside the parameter's own slot.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `match(o, .Some(s) => s, …)` for `o : Option(&(String, q))`, result `-> &(String, q)` | E0912 | accept |
| the same, elided: `o : Option(&String)`, result `-> &String` | E0912 | accept |
| a `self : &Self` method, `.Some(s) => s` out of `o : Option(&String)`, `.None => &self.items(0)` (ledger: j28) | E0912 | accept at the definition |
| returning `o` itself, `(fn(o : Option(&String)) -> Option(&String))(o)` | accepted, runs | accept |
| `match(&o, .Some(s) => s, …)` for an OWNING `o : Option(String)` | E0912 ("`o` is a by-value parameter") | E0912 |
| `get :: (fn(h : H) -> &String)(h.r)` for `H :: struct(r : &String)`: the reference FIELD of a by-value holder returned (measured while writing this up; possibly a second code path) | E0901 ("cannot copy `h.r`, whose type `String` is move-only") | accepted |

## Root cause

`_ref_payload_root_error` (`src/evaluator/builtins/ptr_fns.yo`) checks a projection result that is a `match` binding
of a reference payload. It computes the scrutinee's roots with `projection_call_root_args(&scr, ctx)`, which only
knows CALL scrutinees (its doc comment: "A scrutinee that is not a call keeps the local rule's error"). For the
parameter `o` it returns no roots, `checked` stays 0, and the function raises the "borrows none of them … storage
ends with the call" error. A by-value parameter whose TYPE carries origins is not a local here: the payload reference
points where those origins point.

## Expected

Accept both programs. `plans/backlog/REFERENCES_AND_ORIGINS.md` O3's return rule: "an origin in a result type may
name only origin parameters or reference-typed parameters' places (a by-value parameter contributes its type's
origin parameters, never its own place)"; `s`'s origin is `q` (spelled) or `o`'s elided origin, which O2's default
for an elided result (the union of the reference-holding parameters, restated 2026-11-11 for audit A10: "an elided
`-> Option(&T)` or `-> H` is the union of the reference-holding parameters exactly as `-> &T` is") includes. A
payload binding out of a non-call scrutinee takes the scrutinee's ORIGIN (R-ARM over `origin_held_by`, which already
says a parameter passed bare contributes "only its registered entries, never its own place"), and the return rule
judges that. Only a place inside the parameter's own slot (`…-neg.yo`) stays E0912.

## Test

With the fix: the two programs as positive rows and `…-neg.yo` as a negative row in `tests/origins/corpus.tsv`
(`return-ref-from-by-value-option-param`, `return-ref-from-by-value-option-param-elided`,
`return-ref-into-owning-param`, E0912), or the same three in `tests/origins/reference_read_rule.test.yo`.
