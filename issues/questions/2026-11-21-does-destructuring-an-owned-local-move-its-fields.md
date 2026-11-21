# Does `{ a, b } := x` with an owned `x` move the fields out, or only borrow them?

**Kind:** design question

**Verdict:** ADOPTED (VERDICTS-76, 2026-11-22) — `{ a, b } := x` on an owned `x` CONSUMES
`x`, decision 26's match-twin: the bound names own their fields, unbound parts drop at the
binding, and a later use of `x` is E0901; borrowed sources (a `&T` parameter, a reference
binding, a `match`/`for` binding) keep today's borrowing destructure; there are no partial
moves — stricter than Rust. Confidence 0.85. The implementation needs a decision-26-sized
evaluator + codegen change with a site sweep and is scheduled for v0.2.81; until it lands
the guide shows the `match` form, which works today.

Found while writing `docs/en-US/OWNERSHIP_AND_BORROWING.md` (2026-11-21). The guide's "No partial
moves" section says to "move the whole value and destructure it: `{ name, age } := p`". The tree
does not do that:

```yo ignore
{ String } :: import("std/string");
Account :: struct(name : String, balance : i64);
owner_name :: (fn(a : Account) -> String)({
  { name, balance } := a;
  name // error[E0901]: cannot copy `name` … it is borrowed (a `&T` parameter or a `match`/`for` binding)
});
```

The same happens for an owned local (`a := Account(...)`; `{ name, balance } := a; s := name;`).
`match(a, { name, balance : _ } => name)` is accepted: a by-value `match` consumes its scrutinee
and its arm owns the bound parts (decision 26).

## What the tree does today

`src/evaluator/exprs/destructuring-assignment.yo` binds every destructured name with
`is_owning_the_rc_value = false` (the call sites are commented "(stub)"), and codegen
(`_emit_destructurings`, `src/codegen/exprs/init-assignment.yo`) emits a bitwise `T name = x.f;` per
field with no dup. The source keeps ownership and drops its fields at its own scope end, so the
names are borrowed views of `x`'s fields: moving one out is E0901, and `x` stays usable afterwards.

## What the documents say

- `plans/VALUES_BY_DEFAULT.md` decision 19 ("No partial moves") lists "a whole-value destructuring
  (`{ a, b } := x`)" as an alternative to moving a field out, beside `x.field.clone()`, `take` and
  `replace`. That reads as: the destructuring consumes `x` and its names own the fields.
- `plans/reference/RC_OWNERSHIP_IMPLEMENTATION.md` item 8 (pre-VBD): "Both destructuring assignment
  and match destructuring borrow by default". Decision 26 later made a by-value `match` consuming;
  the destructuring assignment was not changed with it.
- `docs/en-US/DESIGN.md` shows `_(name, age) := p; // name : String, age : i32` with no statement either way.

## Options

1. **The destructuring consumes an owned source.** `{ a, b } := x` with `x` an owned local or a
   temporary moves `x` (a later use is E0901); each bound name owns its field and is dropped at its
   own scope end; an unbound part with a drop (`b : _`, a field a spread or the list leaves out) is
   dropped at the binding, as a consuming `match` arm drops its hidden bindings (decision 26). A
   borrowed source (a `&T` parameter, a reference binding, a `match`/`for` binding) keeps today's
   borrowing destructure. This is an evaluator and codegen change of the size of decision 26's
   consuming arm, not a diagnostic fix.
2. **The destructuring borrows, by design.** The guide (en + zh-CN) shows
   `match(p, { name, age } => …)` as the way to move a whole value apart, decision 19's bullet is
   corrected, and the E0901 text for a destructured name says "destructured from `x`, which still
   owns it: `match(x, { … } => …)` moves `x` apart".

## Recommendation

Option 1. Decision 19 is the newer, authoritative statement, `match` already behaves this way, and
a binding form that cannot take apart a value it is given by value leaves Yo with no non-`match`
spelling for Rust's `let P { name, age } = p;`. Until it lands, the guide should show the `match`
form, which works today under both options.
