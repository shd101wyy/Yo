# A consuming `match` of a type with a user `Drop` never runs its destructor

**Severity:** S2 — `match(g, { name, n } => …)` on a value whose type implements `Drop` moves the fields into the arm and silently skips `drop` (a lock guard, a file wrapper or a counter's destructor never runs); Rust rejects the move (E0509).

Found while implementing VERDICTS-76 Q2 (the Fable review's §7: "state what a consuming destructure does to a
type with a user `Drop` … the consuming match accepts it today"). The destructuring now rejects it
(E0901, "`G` implements `Drop`: moving its fields out would skip its destructor"); the consuming `match`
does not.

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
G :: struct(name : String, n : i32);
impl(G, Drop(drop : (fn(self : &mut Self) -> unit)(println("drop G"))));
main :: (fn() -> unit)({
  g := G(name : String.from("ann"), n : i32(7));
  s := match(g, { name, n } => name);
  println(&s);
});
export(main);
```

`yo check` accepts it, and the program (develop `77af20c87`, `--sanitize address --allocator system`)
prints only:

```text
ann
```

`drop G` is never printed. ASan reports nothing: the fields are dropped once, by the arm's bindings.

## Root cause

`_decide_match_mode` (`src/evaluator/exprs/match.yo`) consumes the scrutinee of any type that is not
implicitly copyable, and the consuming arm's bindings and hidden bindings take over every part. No path
runs the scrutinee's own `Drop` impl: the arm drops the parts, never the whole. The same holds for an arm
that binds nothing by value (`.A => …`, `_ => …` over an enum with a `Drop` impl): the scrutinee is
consumed and its destructor is skipped there too.

## Fix direction

A consuming arm whose pattern moves a part out of a value of a type with a user `Drop` is E0901, as the
destructuring is (Rust's E0509); an arm that moves no part out drops the scrutinee whole (its destructor,
then its fields) on entry. It is not a one-line check on a path the destructuring shares: the arm-entry
drops and the coverage of an arm that binds nothing both change, so it is its own fix with a test
(`drop G` printed exactly once, or the E0901).
