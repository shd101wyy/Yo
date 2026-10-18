# A `mut` match on a field or a dereference writes a copy

**Severity:** S1 — a `match(&mut s.f, …)`, `match(&mut h.f, …)` (a `ref`
object's field) or `match(&mut b.*, …)` arm's write is silently lost, and
replacing a counted payload double-frees the scrutinee's own value.

Found while fixing
`issues/fixed/a-mut-match-place-binding-cannot-live-across-an-await.md`,
whose field-path case rides on this.

## Symptom

```yo
S :: struct(o : Option(String), k : i32);
main :: (fn() -> unit)({
  (s : S) = S(o : .Some(String.from("a")), k : i32(0));
  match(
    &mut s.o,
    .Some(t) => {
      t = String.from("bbb");
    },
    .None => ()
  );
  println(&match(&s.o, .Some(v) => v.len(), .None => usize(0)));
});
```

prints nothing and aborts with `tcache_thread_shutdown(): unaligned tcache
chunk detected` (glibc). With an `Option(i32)` payload it prints the old
value: `match(&mut h.o, .Some(n) => { n = (n + i32(1)); }, …)` leaves `h.o`
at `.Some(1)`, and so does `match(&mut b.*, …)` for a `Box`.

## Root cause

The evaluator gives a non-atom place scrutinee (`s.o`, a field chain, `b.*`)
a temp `variable_name`, and `_generate_match_expression_body`
(`src/codegen/exprs/match.yo`) materializes every non-atom subject into that
temp before the arms run:

```c
__yo_t_… tmp = __yo_v_s.__yo_v_o;                       /* a copy, no dup */
__yo_t_…* __yo_v_t = &(tmp.data.__yo_v_Some.__yo_v_value);
(*__yo_v_t) = new_string;                               /* writes the copy */
__yo_decr_rc(old);                                      /* frees s.o's payload */
```

The place binding (`_emit_place_binding_decl`) then points into the copy.
For a by-value or `&` match the copy is harmless (the arms only read), but a
`mut` match's bindings are places INTO the scrutinee (decision 26): the write
lands in the copy, and replacing a counted payload releases the old value
that `s.o` still holds, so its drop at scope end frees it again. A plain local
scrutinee (`match(&mut o, …)`) is an atom and was never copied, which is why
the decision-26 tests passed.

## Fix

A `mut` match never materializes its subject: the place's own code (an lvalue:
`s.o`, `h->o`, `(*b)`, or `sm->var_s.o` in a task) is what the tests and the
place bindings address. The evaluator gives such a subject no dup or drop (it
is a place expression, `is_place_expression`), so nothing else reads the temp.

## Verification

`tests/parameter_modes.test.yo`, "a mut match on a field or a dereference
writes the scrutinee's part": a field of a value struct with a `String`
payload, a `ref` object's field and a `Box` dereference. It fails before the
fix (the old values remain, and the `String` case aborts) and passes after.
