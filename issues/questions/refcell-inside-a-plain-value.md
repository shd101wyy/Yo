# May a `RefCell(T)` sit inside a plain value, or only behind `Rc`/`Arc`? (OPEN-DESIGN)

**Kind:** design question — an open decision, not a defect. Filed 2026-10-10
with decision 41 (`plans/VALUES_BY_DEFAULT.md` §3.10: `RefCell(T)` is the one
spelling of the dynamic exclusivity check).

## The hole

Decision 41 adds `RefCell(T)` for the write-through-a-shared-handle case
the summaries cannot decide. Behind `Rc`/`Arc` its meaning is clear. Inside
a **plain value** — a struct field `S :: struct(log : RefCell(ArrayList(String)))`
held by one owner — it means interior mutability through an `imm` borrow:
`f(imm(s) : S)` may call `s.log.with_mut(...)`. Rust allows this (`&S` over
an `UnsafeCell`), and uses it for caches, memoization and counters behind
`&self`. Yo's `imm` has so far meant "unchanged for the call", which is
what the verifier and the mutation summaries assume (`§3.12`, Stage-1
summaries), and what decision 28's call-site exclusivity is checked
against.

## Options

1. **Only behind `Rc`/`Arc`.** `RefCell(T)` is accepted as the payload of
   a handle (`Rc(RefCell(T))`, `Box(RefCell(T))`) and rejected as a field
   of a value type or a local. `imm` keeps meaning unchanged everywhere;
   a cache behind `imm(self)` must become `Rc(RefCell(C))`, one more
   allocation and count per such field.
2. **Anywhere, verifier-excluded.** A `RefCell` may be a field of any
   type or a local. `imm(x) : T` means "unchanged" only when `T` reaches
   no `RefCell`; the verifier treats a `RefCell`-reaching value as outside
   its subset (as it treats `Rc` today), and the mutation summaries record
   a `RefCell` `with_mut`/`get_mut` as a write to that cell (so decision
   28's overlap check still sees it). Rust's position.
3. **Anywhere, with `imm` rejected on `RefCell`-reaching types.** A value
   reaching a `RefCell` can be passed only by `mut` or by value, so `imm`
   stays unconditional. Honest but heavy: every type with one such field
   loses `imm` lends everywhere.

## Recommendation

Option 2. It is Rust's rule, it costs the verifier nothing it does not
already pay for `Rc`, and the summaries already model writes to places —
a `with_mut` is one more write site. Option 1 forces an allocation for a
cache behind `imm(self)`, the commonest `RefCell`-in-a-value shape, which
is exactly the hidden cost the plan removes elsewhere. The docs must state
the consequence plainly: `imm` is a promise about the lender's view, and a
`RefCell` field is where that promise is explicitly waived. Decide with
V1's `RefCell` PR; the test is an `imm(self)` method that writes a
`RefCell` field and a verifier case that excludes it.
