# How should the `mut(name)` marker strip stop writing the AST?

**Kind:** design question: an open decision, not a defect. Filed 2026-10-30
with V4 `AstExpr` (branch `vbd/v4-astexpr-children-r3`, `plans/VALUES_BY_DEFAULT.md`
V4), which made a call's `args` an `Rc(ArrayList(Self))`.

## The question

`strip_mut_marker` (`src/evaluator/utils.yo`, decision 47 step 2) rewrites the
`mut(name)` binder marker to the bare `name` in place. It copies the holder's
argument list out of the `Rc(sm_args)` binder and assigns an element:

```yo ignore
list := sm_args;
list(idx) = name;
```

The write lands in the tree only because `ArrayList` is still a `ref` type, so
the copy shares the list. After B8 (`ArrayList` a value) the copy is a deep copy
or E0901, and a `.clone()` added to compile it would lose the write without any
error. The V4 audit of writes through an `Rc(ArrayList(Self))` child found two
such sites. The verifier's `strip_proved_ensures_asserts` was the other one; V4
turned it into a side table (`note_stripped_statement`, `src/expr_info.yo`), as
the consultation on VERDICTS-10 asked. This one has eight call sites
(`binding.yo`, `initialization_assignment.yo`, `assignment.yo`,
`destructuring_assignment.yo`, `match.yo`, `strip_pattern_mut_markers`), and
its readers are every later pass that sees the binder.

The obvious mechanical replacement, building a new list and assigning
`holder.args = Rc.new(new_list)`, is unsound here. Two callers pass a COPY of
the node (`mut_holder := … lhs.clone() … expr.clone()`, from the B4 explicit-copy
sweep). `AstExpr.Clone` makes a new node that shares the list. Today the
in-place element write reaches the original node through the shared list. A
field write would reach only the copy, and codegen, which reads the original,
would still see `mut(name)`. It also writes a built node, which V5 (an `AstExpr`
handle with a read-only payload) rejects.

## Options

1. **Strip at desugar time.** `desugar_if_calls` already rewrites the `&T`
   borrow slots into `__yo_imm(x) : T` while it builds the tree. The `mut(name)`
   positions are syntactic: the left side of `:=`, a `(… : T) =` declaration,
   match-arm patterns, destructuring fields and capture lists. The desugarer
   would build the bare name and record the binding (`register_mut_binding` is
   keyed by the token) along with the shape error. The evaluator then sees no
   marker.
2. **A side table.** Record the marker call's `ExprId`, and have every reader
   that takes the binder's name look through a recorded marker. This is
   write-free, but every reader needs the change.
3. **A writable child cell.** Make `args` an `Rc(RefCell(ArrayList(Self)))` and
   write through `with_mut`. This keeps the in-place semantics but makes every
   read pay for the cell. It also contradicts decision 21's premise that a tree
   is immutable once built.

## Recommendation

Option 1. The marker is surface syntax, as the borrow sigils are, and
`desugar_if_calls` is where those are already lowered. It is the only option
that leaves both the evaluator and every later pass write-free without a cost
per read. It must land before B8 flips `ArrayList`. Until then the in-place
write is correct, because the list is a shared `ref`.
