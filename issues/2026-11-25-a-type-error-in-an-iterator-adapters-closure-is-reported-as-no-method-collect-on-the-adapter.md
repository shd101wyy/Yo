# A type error inside an iterator adapter's closure is reported as `No method "collect"` on the adapter

**Severity:** S3 — a wrong-location, wrong-code diagnostic: the real error (E0926 at the closure body) is swallowed and the consumer call (`collect`, `count`, ...) reports E0610 on an unspecialized `IterMap(...)` type; the adapter alone, never consumed, is accepted without any error.

Found 2026-11-25 by the std-against-Rust audit (`plans/backlog/STD_RUST_ALIGNMENT.md` §3.1, probe a5). Filed by the S-0 PR.

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array-list");

main :: (fn() -> unit)({
  mut(xs) := ArrayList(i32).new();
  xs.push(i32(1));
  t := (&xs).into_iter().map(x => (x.* * i32(2))).count();
  println(t);
});
export(main);
```

`yo check tmp/fixme.yo` (tree binary at `8da9761d1`):

```text
error[E0610]: No method "count" on IterMap(I : (Iterator), B, F : (FnMut(&A) -> B)): the type has no field or method with that name.
Receiver slot types probed: IterMap(I : (Iterator), B, F : (FnMut(&A) -> B)), &IterMap(I : (Iterator), B, F : (FnMut(&A) -> B)), &mut IterMap(I : (Iterator), B, F : (FnMut(&A) -> B)), &&IterMap(I : (Iterator), B, F : (FnMut(&A) -> B)).
  --> tmp/fixme.yo:5:50
  |
5 |   t := (&xs).into_iter().map(x => (x.* * i32(2))).count();
  |                                                  ^
help: run `yo explain E0610` for more information
```

`collect(ArrayList(i32))` in place of `count()` fails the same way. The item of `(&xs).into_iter()` is `&i32`, so the closure's `x` is a `&&i32`, `x.*` is a `&i32`, and `&i32 * i32` is E0926 (the same expression as a plain function body is `error[E0926]: \`r\` is a reference (\`&i32\`): reading the value it refers to is spelled \`r.*\``, at the operand). With the `map(...)` call alone (`m := (&xs).into_iter().map(x => (x.* * i32(2)));`, result unused) `yo check` exits 0 and reports nothing.

## Root cause

`map`'s result type is the declared `IterMap(I, B, F)` with `B` bound from the closure body's type. The closure body is only evaluated when the adapter's `Iterator` impl is specialized, which happens at the first method lookup on the adapter value. That specialization fails (E0926 in the body), the failure is swallowed as a candidate miss (`YO_DEBUG_SWALLOW=1`: `[swallow] error[E0610]: No method "collect" on IterMap(...)`), and `B` stays an unresolved binder in the printed receiver type, so the method lookup reports "no field or method with that name" at the consumer. The body's own error, which names the real fix, never reaches the user.

## Fix direction

When a method lookup on an adapter value fails because the impl's specialization raised a body error, re-raise that error (with its own span) instead of E0610; or check the closure literal's body when it is bound to the `F` parameter of `map`, as a call to a plain function checks its body, so the unconsumed adapter is also rejected. Either changes the evaluator's candidate-trial rules (`src/evaluator/calls/function.yo`, the method-miss path of `_no_method_message`) and needs the origins corpus and the iterator tests as gates, which is why S-0 files it instead of fixing it.

## Test

None yet. The fix adds a `tests/cli-cases/` row whose golden names E0926 at the closure body and has no E0610, and a language test that the unconsumed adapter is rejected.
