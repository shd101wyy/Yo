# How does a by-value effect row interact with a `ctl`-carrying handler invoked repeatedly?

**Kind:** design question: an open decision, not a defect. Filed 2026-10-12
while landing the effect-rows-by-value flip on the marker-sweep PR
(`tests/algebraic_effects.test.yo`, the `Yield :: (ctl(v : i32) -> i32)`
family around line 1017).

## The situation

The maintainer ruled (2026-10-11): effect records go by value — the prelude's
`Io.async/await/spawn` and their externs take `e : E`, and the call-site
`&io` markers are gone. Applying the same spelling to generic
`E : Type.Struct` rows in the test corpus exposed a boundary:

- A row of **plain `fn` fields** (the `Io` shape) is plain data: it derives
  `Copy, Clone` and a by-value row moved once per loop iteration is an
  implicit copy — the three `Eff :: struct(yield : Yield, log : Log)` tests
  with `Yield :: (fn(v : i32) -> i32)` now take `e : E` by value with the
  derive (`tests/algebraic_effects.test.yo:966,1007`).
- A row that **transitively contains a `ctl(...) -> ret`** cannot derive
  `Clone` — the derive is rejected with "A function's result type cannot be
  control-bound ... Pass the handler (or the record holding it) downward as a
  parameter instead" — so the row is move-only (decision 36), and passing it
  by value into a callback invoked once per loop iteration is E0901 ("moved
  inside the loop, and the next iteration uses it again"). The ctl-family
  traverse keeps the lend (`e : &E`, `tests/algebraic_effects.test.yo:1024`)
  and its test passes.

## The question

Is the split the tree now encodes the rule?

1. **Rows go by value; a `ctl`-carrying row is move-only and may be passed
   by value only once (a single downward pass — the io.async action shape);
   a multi-invocation callback that receives the row every call takes it
   `&E`** (the lender keeps the row alive across the invocations), or
2. ctl-carrying rows should never appear in a by-value row position at all
   (the borrow is the only spelling), or
3. something decision 43 (references as second-class types) changes here —
   the borrowing-future machinery may give the repeated-invoke shape a
   second-class form.

## Recommendation

Take (1): it is what the landed code already spells, it matches the two
mechanical facts (`fn`-field rows are Copy-derivable, ctl rows are not), and
it keeps the io row's by-value rule unconditional. Record it as a decision
amendment when decision 43's phase lands (the `Fn <: FnMut <: FnOnce` split
gives the vocabulary for "invoked once" vs "invoked many times"), and add a
language test pinning both halves: a fn-field row passed by value into a
loop-invoked callback compiles; the ctl-field spelling of the same program
is E0901 with the lend named as the fix.
