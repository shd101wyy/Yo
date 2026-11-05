# A borrowed-`match` binding returned in an `Option(&T)` dangles

**Severity:** S1 — memory unsafety in safe code: a function returning `Option(&T)` built from a binding of `match(&x.f, …)` returns a pointer to its own stack frame (ASan: stack-use-after-return).

Found while giving `OnceCell(T).get` Rust's `-> Option(&T)` result
(`issues/2026-11-05-oncecell-get-or-init-copies-its-element-so-a-move-only-value-cannot-be-read.md`),
on develop 68b45b81d.

## Symptom

```yo ignore
P :: struct(a : i32, b : i64, c : i64);
H :: struct(v : Option(P));
peek :: (fn(h : &H) -> Option(&P))(
  match(&h.v, .Some(s) => .Some(s), .None => .None)
);
```

`peek(&h)` checks and compiles. Built with `--sanitize address --allocator system`, reading
the result is `AddressSanitizer: stack-use-after-return … '__yo_v_s' <== Memory access …
inside this variable`. Reproducer:
`issues/repros/2026-11-05-a-borrowed-match-binding-returned-in-an-option-of-a-reference-dangles.yo`.

A `String` payload (`Option(&String)`) hits the same hole, but on develop its C fails to
compile first (`issues/fixed/2026-11-05-an-option-of-a-reference-to-a-newtype-is-declared-before-the-newtype.md`).

## Root cause

The evaluator treats a binding of a borrowed `match` as a place inside the scrutinee
(VERDICTS-13 §14), so the N2b composite-result rule accepts `.Some(s)` as rooted at `h`. But
codegen lowers a `&` borrowed-match binding as a by-value copy of the payload in a local
(`__yo_t_… __yo_v_s = …`). Only a `&mut` match's binding is a pointer into the scrutinee
(`T* __yo_v_n = &(…)`). So `.Some(s)` takes the address of the local copy, which dies with
the call.

## Fix direction (decision needed)

Either:

- lower a `&` borrowed-match binding whose reference escapes the arm as a pointer into the
  scrutinee, as the `&mut` binding is lowered; or
- reject a borrowed-match binding flowing into a returned reference until it is.

A `-> &T` projection yielding such a binding (`match(&self.v, .Some(s) => &s, …)`) is the
same hole, and decision 24's root rule rejects it today (E0912).

## Test

The fix adds the reproducer as a test, run under `--sanitize address`, and moves this doc to
`issues/fixed/`.
