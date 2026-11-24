# Pattern Matching

`match`: the pattern forms, guards, exhaustiveness, and how a `match` takes
its scrutinee. Enums and ADTs are in [DATA_TYPES.md](./DATA_TYPES.md).

## Overview

The compiler performs exhaustive checking on pattern matching.

```yo
Coin :: enum(
  Penny,
  Nickel,
  Dime,
  Quarter
);

// Reference:
// - https://doc.rust-lang.org/book/ch06-02-match.html
// - https://github.com/tc39/proposal-pattern-matching
value_in_cents :: (fn(coin : Coin) -> u8)(
  match(
    coin,
    .Penny => {
      printf("Lucky penny!\n");
      1
    },
    .Nickel => 5,
    .Dime => 10,
    .Quarter => 25
  )
);

Shape :: enum(
  Circle(r : i32),
  Rectangle(w : i32, h : i32)
);

area :: (fn(shape : Shape) -> i32)(
  match(
    shape,
    .Circle(r) => (i32(3) * (r * r)),
    .Rectangle(w, h) => (w * h)
  )
);
```

## Pattern forms

A pattern is an ordinary expression; the compiler reads its shape. Because Yo
has no operator precedence, every infix pattern is written in its own
parentheses.

| Form | Example | Meaning |
| --- | --- | --- |
| wildcard | `_ => …` | matches anything, binds nothing |
| binding | `other => (other + 1)` | matches anything, binds the value |
| constant | `0`, `-1`, `true`, `'a'`, `"lit"`, `i32(5)`, `TEN`, `Color.Red` | compared with `==`; a `::` constant in scope holding a literal or enum value is a constant pattern, any other identifier is a binding |
| variant | `.V`, `.V(p, q)`, `.V(label : p)`, `.V({ a, b : p })` | sub-patterns may be any pattern, at any depth |
| or | `(.Red \| .Green)`, `(1 \| 2 \| 3)` | alternatives must bind the same names |
| range | `(0..10)`, `(10..=19)` | half-open / inclusive, compile-time bounds |
| whole-value binding | `(whole := .Some(v))` | binds the whole value and matches the sub-pattern |
| guard | `(.Some(v) && (v > i32(100)))` | the arm runs when the pattern matches and the guard, which sees the bindings, is true |
| tuple | `(0, y)`, `(_, .Some(v))` | exact arity, one sub-pattern per element |
| named struct | `Point(x : 0, y)`, `Person(name : "alice")` | labeled or bare-field, partial (unlisted fields match anything) |
| anonymous struct | `{x : 0, y}` | at a struct position, like the variant curly form |
| wrapper | `Rc(p)`, `Arc(p)`, `Box(p)` | looks through the cell at an `Rc(T)`/`Arc(T)`/`Box(T)` position; `p` matches the `T` inside; inside `Rc(p)`/`Arc(p)` the bindings borrow |

```yo
classify :: (fn(r : Result(Option(i32), str)) -> i32)(
  match(
    r,
    .Ok(.Some(0)) => i32(0),
    (.Ok(.Some(v)) && (v < i32(0))) => i32(-1),
    .Ok(.Some(v)) => v,
    .Ok(.None) => i32(-2),
    (.Err("timeout") | .Err("closed")) => i32(-3),
    .Err(_) => i32(-4)
  )
);

bucket :: (fn(n : i32) -> str)(
  match(
    n,
    (0 .. 10) => "small",
    (10 ..= 99) => "medium",
    other => cond((other < i32(0)) => "negative", true => "large")
  )
);

command :: (fn(s : String) -> i32)(
  match(s, "compile" => i32(1), ("check" | "fmt") => i32(2), _ => i32(0))
);
```

A tuple scrutinee takes one sub-pattern per element; a struct scrutinee takes
labeled sub-patterns (a bare field name binds that field; unlisted fields
match anything). A wrapper pattern `Rc(p)`, `Arc(p)` or `Box(p)` names the
cell it looks through, as in Rust: `p` matches the `T` inside the
`Rc(T)`/`Arc(T)`/`Box(T)` at its position, at any depth, and the cell's
variants count toward exhaustiveness. A binding inside `Rc(p)` or `Arc(p)`
borrows the payload, because other handles may share the cell;
`(c := Rc(p))` binds the cell itself. An `Rc(T)` or `Arc(T)` position takes
only the wrapper spelling: a structural pattern there without it is E0609,
whose help names `Rc(p)`. A missing case is printed through the wrapper
(`.Node(Rc(.Leaf(_)), _)`). At a unique `Box(T)` position a pattern without
`Box(…)` is also looked through implicitly:

```yo
axis :: (fn(t : Tuple(i32, i32)) -> i32)(
  match(
    t,
    (0, y) => y,
    (x, y) => ((x * i32(10)) + y)
  )
);

Point :: struct(x : i32, y : i32);
origin_only :: (fn(p : Point) -> bool)(
  match(
    p,
    Point(x : 0, y : 0) => true,
    _ => false
  )
);

// A recursive enum through Rc: `Rc(p)` matches the inner List.
List :: enum(Nil, Cons(head : i32, tail : Rc(Self)));
second :: (fn(l : List) -> i32)(
  match(
    l,
    .Cons(_, Rc(.Cons(h, _))) => h,
    .Cons(h, _) => h,
    .Nil => i32(-1)
  )
);
Tree :: enum(Leaf(n : i32), Node(l : Rc(Self), r : Rc(Self)));
leaves :: (fn(t : Tree) -> i32)(
  match(
    t,
    .Node(Rc(.Leaf(a)), Rc(.Leaf(b))) => (a + b),
    .Node(_, _) => i32(-1),
    .Leaf(n) => n
  )
);
```

A tuple or struct scrutinee is always exhaustive over its single constructor:
a match is exhaustive when the element/field sub-patterns together cover
every element (a missing element/field is named in the witness, e.g.
`(_, 1)` or `Point(x : _, y : (101 ..= 149))`).

Arms are tried in source order and the first match wins. Exhaustiveness is
checked structurally: `.Some(true), .None` is rejected with
`Missing case: .Some(false)`, and a missing variant is named with its payload
(`Missing case: .Circle(_)`). Integer constants and
ranges are intervals of the scrutinee's type: `(0..=255)` alone covers a `u8`,
and a gap is reported as a range (`Missing case: (101 ..= 149)`). `usize` and
`isize`, whose range differs between targets, floats and strings need a
wildcard or binding arm. A guarded arm never counts as covering its pattern;
when a guard is what leaves a value unmatched, the error's help line says so.

An arm that can never run is an error (`Unreachable match arm`, E0608) when one
earlier arm alone matches everything it matches (a second `.Red`, anything
after `_`, `(5..=7)` after `(0..10)`), when an earlier alternative of its own
or-pattern does (`(1 | 1)`), or when no value of the scrutinee's type matches
it (the empty range `(5..5)`, a GADT variant the type excludes). An arm that
the earlier arms match only together, such as `.Some(_)` after `.Some(true)`
and `.Some(false)`, is a warning. A trailing `_` or binding arm is always
accepted. How the bindings hold the matched value is the next section's.

Inside an `io.async` arm that awaits, every pattern form works: the arm's
tests and bindings run on the state machine's initial pass and the body keeps
the ordinary suspension/resume machinery (`plans/reference/MATCH_PATTERN_MATCHING.md`
§4.9).

## How a `match` takes its scrutinee

A `match` takes its scrutinee the way a parameter takes its argument
(Rust's default binding modes):

| Scrutinee | The arms' bindings |
| --- | --- |
| an owned local, a by-value parameter or a temporary, of a type that is not implicitly copyable | the scrutinee is moved into the `match`: the selected arm's bindings own their parts |
| a `&T` reference binding (a `x : &T` parameter, `y := &place`, a binding of a borrowing `match`) | read-only borrows |
| a `&mut T` reference binding (a `x : &mut T` parameter, `y := &mut place`) | `mut` places: writing a binding writes the scrutinee |
| `match(&x, …)` | read-only borrows; `x` stays usable |
| `match(&mut x, …)` | `mut` places; `x` stays usable |
| a `Copy` value | copies, as a by-value parameter does |

```yo
Fd :: struct(n : i32);
impl(Fd, Drop(drop : (fn(self : &mut Self) -> unit)(())));
Two :: enum(Two(a : Fd, b : Fd), Zero);

take :: (fn(f : Fd) -> i32)(f.n);

first :: (fn(p : Two) -> i32)(
  match(
    p,
    .Two(a, _) => take(a), // `b` is dropped when the arm is entered; `a` moves on
    .Zero => i32(0)
  )
);

peek :: (fn(p : &Two) -> i32)(
  match(p, .Two(a, _) => a.n, .Zero => i32(0)) // borrows: nothing moves
);

main :: (fn() -> unit)({
  p := Two.Two(a : Fd(n : 3), b : Fd(n : 4));
  n := match(&p, .Two(a, _) => a.n, .Zero => i32(0)); // borrows; p stays
  r := first(p); // p moves into `first`
  (mut(o) : Option(i32)) = .Some(i32(1));
  match(
    &mut o,
    .Some(v) => {
      v.* = (v.* + i32(1));
    },
    .None => ()
  ); // o is .Some(2)
});
```

The rules of a consuming `match`:

- Guards see the bindings as borrows; the move happens when an arm is
  selected, so a guard that fails leaves the payload for the next arm.
- The parts an arm does not bind (`_`, a field it does not list) are dropped
  when the arm is entered. A binding the arm still owns at its end is dropped
  there; one it moves is gone.
- Below a reference cell (an `Rc`/`Arc` payload the pattern looks through)
  the bindings borrow, and the handle lives until the arm ends.
- A use of the scrutinee after a consuming `match` is E0901, whose help names
  `match(&x, …)`. Matching a module-level binding, a field (`x.f`), an element
  (`xs(i)`) or a dereference (`p.*`) by value is E0901 too (Yo has no partial
  moves): write `match(&x.f, …)`, or move the field out first with
  `std/mem`'s `take(&mut x.f)` or `replace(&mut x.f, v)`.
- `(name := p)` takes the whole value, so a binding inside `p` must be `Copy`.
  An or-pattern may not leave a part with a drop unbound (its alternatives
  would drop different parts): split the arm or bind the part.

A `mut` place is exclusive while it is live: the arm reads, writes or moves the
scrutinee only through it (E0911), and `&mut` needs a writable place (an `imm`
binding is E0908, a temporary is an error). Inside an `io.async` body a place
lives across an `await`, unless its scrutinee passes through a reference cell
or a module-level place: another task could reach that place while this one is
suspended (E0911, the rule for local borrows).
