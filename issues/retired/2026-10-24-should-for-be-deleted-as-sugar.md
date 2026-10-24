# Should `for` be deleted as syntax sugar, like `for_await`?

**Kind:** design question. **Decided 2026-10-24 (maintainer, with an independent advisor review): keep `for`.**
It becomes a parser desugar in the macro plan's Part B, B1 (`plans/backlog/MACRO_AND_ISO_REMOVAL.md`). All its
forms stay: the value form, the read walk `for(&xs, …)`, the borrowed walk `for(&mut xs, …)`, and the map form
`(k, v) =>`. A middle ground that keeps only the borrowed forms was considered and rejected. The analysis below is
the record the decision was made on.

## The question

The same day, `for_await` was deleted as pure sugar
(`issues/retired/2026-10-24-should-for-await-stay-or-fold-into-for.md`). The maintainer asked whether `for`,
which is also sugar, should go the same way.

## What holds

Probes on develop `f271ed005` with the tree binary:

- **A closure API is not a replacement.** A Yo closure cannot leave the enclosing function. `return(i32(99))`
  inside `for_each(x => …)` is checked against the closure's own `unit` result (E0605), and a `break` there is
  "only … inside a loop". So `for_each` (`std/prelude.yo`, about line 12389) or an `each_mut` cannot stand in for a
  loop with early exits. The only hand-written alternative is `while`.
- **The value form can be written by hand.** It takes four statements:
  `mut(it) := xs.into_iter(); while(runtime(true), { match(it.next(), .Some(x) => …, .None => { break; }) })`.
  `return` and `break` work inside it.
- **The borrowed walks can also be written by hand, from user code and without `AllowUnsafe`:**
  `c := &mut xs; g := __borrow_guard(c); mut(cur) := c.walk_start(); while(c.walk_valid(&cur), cur = c.walk_next(&cur), { e := c.walk_elem(&cur); … })`.
  The map form works the same way. Static exclusivity (E0911 on an `xs.push` in the body) follows from the ordinary
  live-range rule on `c`; it does not depend on the macro.

Hand-writing is possible, then. What `for` provides is this:

1. **A guard that cannot be forgotten.** Leaving out `g := __borrow_guard(c)` compiles silently, and no diagnostic
   exists for that, so the runtime check against alias-mutation is lost. The borrowed walk is also six statements
   instead of one, and `__borrow_guard` and `walk_*` would become public surface.
2. **The hidden owning local for a source that is not a place** (`__for_source_is_place`). Every hand-written loop
   would have to reproduce it.
3. **The verifier's only model of list iteration.** `src/verifier/vc.yo` dispatches on the `for` head (about line
   4024). `_for_term` (about line 3250) gives the ghost index and `produced(xs)`, with fixtures
   `tests/spec/fixtures/valid/for_produced.yo` and `negative/for_produced_false.yo`. Its own comment puts the
   `while` + `iter.next()` replacement outside the subset, because it is an uncontracted trait call over collection
   state. Deleting the value form would delete verified list iteration until a collection model exists. That
   also rules out the middle ground: the value form is the easiest to write by hand, but it is the only form the
   verifier understands.
4. **One place for decision 43 to retarget.** Step 4 (N3) moves the borrowed `for` from `BorrowedWalk` to
   `impl(&C, IntoIterator)` with origins (`plans/backlog/REFERENCES_AND_ORIGINS.md`). A parser-owned desugar makes
   that a change in one place.
5. **The documented way to borrow an element.** Element places `xs(i)` cannot be bound by hand. The help texts of
   E0908, E0911, E0912 and E0914 recommend `for(&mut coll, x => …)` as the way to borrow an element.

`for` also hides nothing dangerous. Its body is an ordinary `while` block with real `break`, `continue` and
`return`, and it does not suspend, allocate or transfer control behind a name. That is the difference from
`for_await`, which hid a suspension point and had only test callers.

**Call sites** (`(?<![\w.])for\(` over `.yo` and `.md`):

| Where | `for` call sites |
| --- | --- |
| src | 6 loops (`doc/builder.yo:2212`, `suspension_analysis.yo:669`, `comptime_expect_error.yo:287` in the `&` form, `lsp/server.yo:876/:1242/:1260`); the other 40 matches are diagnostic and help strings |
| std | 0 loops (the matches are the macro itself and doc comments) |
| tests | 196 sites in 44 files: 66 `&mut`, 9 `&`, 16 map-form; 11 files use `break`/`continue` in a `for` body; `tests/for_macro_borrow*.test.yo` alone pin 63 |
| docs/en-US, `.github`, plans | 39, 50, 168 |

## Recommendation

Keep `for` and lower it in the parser (B1), as `if` → `cond` already is. Do not reduce it to the borrowed forms.
This is the maintainer's decision of 2026-10-24.
