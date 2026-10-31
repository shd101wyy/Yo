# How should the `mut(name)` marker strip stop writing the AST?

**Kind:** design question (decided; implemented on
`fix/ast-immutable-before-b8`). Filed 2026-10-30 with V4 `AstExpr` (branch
`vbd/v4-astexpr-children-r3`, `plans/VALUES_BY_DEFAULT.md` V4), which made a
call's `args` an `Rc(ArrayList(Self))`.

**Status:** DECIDED 2026-10-31: option 1, strip at desugar time (Fable
consultation #11, below). The other in-place writes through a copy of a call's
argument list that the consultation found are gone with it.

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

## Verdict (Fable consultation #11, 2026-10-31)

**Option 1.** The marker is stripped at desugar time in `desugar_if_calls`,
which already peels `match(&x, …)` and records it in a token-keyed table
(`g_borrowed_match_sites`). Option 2 was rejected because the marker has too
many readers, codegen's `_module_init_var_atom` among them, and option 3
because it contradicts decision 21's premise that a tree is immutable once
built. The consultation also found four more writes of the same kind that
break under B8: the `thread_local(name)` strips in
`evaluator/exprs/assignment.yo` and `evaluator/exprs/initialization_assignment.yo`,
which go to the same desugar branch, and three type-directed evaluator
rewrites that codegen reads, which take the side-table shape of
`note_stripped_statement`.

## As implemented

- **The registry.** `register_mut_binding` / `is_mut_binding` and
  `register_thread_local_binding` / `is_thread_local_binding` live in
  `src/expr.yo` beside `g_borrowed_match_sites`, keyed by the declared name's
  token (`module|row:col|name`). The `mut` registry moved there from
  `src/expr_info.yo`.
- **The desugar.** `_strip_mut_binders` (`src/expr.yo`) rewrites decision 47's
  binder positions while the tree is built, and `_contains_desugar_target`
  finds them: the left side of `:=` / `::` (`mut(x)`, `comptime(mut(x))`,
  `thread_local(x)`, `thread_local(mut(x))`), the name of a
  `(… : T) = v` declaration, a `(mut(x) : T);` statement in a block or at
  module level (`desugar_program_if_calls`), the fields of a destructuring
  left side, and the bindings of a `match` arm pattern (never its guard). A
  `fn(...)` or closure parameter, a named argument and a `quote` body keep the
  marker; `mut(x) : T` on a parameter is still E0009.
- **The evaluator** reads the registry at the five former strip sites
  (`binding.yo`, `initialization_assignment.yo`, `assignment.yo`,
  `destructuring_assignment.yo`, `match.yo`). `strip_mut_marker`,
  `strip_pattern_mut_markers` and the two clone holders are deleted. A
  malformed marker (`mut(x.f)`, `mut(1)`) stays in the tree and is rejected
  where the binding is evaluated, with the same span and message
  (`reject_malformed_mut_marker`, `reject_malformed_pattern_mut_markers`).
- **The three evaluator rewrites** (the auto-dereference of a field read,
  `w.f` → `w.*.f`; the payload-method retry, `w.m(…)` → `w.*.m(…)`; the
  `dyn(v)` auto-box, `dyn(v)` → `dyn(Rc.new(v))`) record the rewritten node
  under its own id (`note_rewritten_node`, `src/expr.yo`) instead of writing
  the argument list. Their readers go through `ast_rewritten_node` /
  `ast_rewritten_view`: the rewrite sites themselves on a re-evaluation,
  `clone_expr_fresh_ids`, the codegen dispatch (`_call_generate_expr`), the
  two codegen collection walks, the method-call emitter's callee, and the
  evaluator's and codegen's place walks.
- **Tests.** `tests/internal/parser.test.yo` ("decision 47: …", four tests:
  the stripped forms, `thread_local`, the registry, and the forms that keep
  the marker); `tests/mut_bindings.test.yo` (a malformed marker in each
  binder position, and a module-level `(thread_local(mut(g)) : i32) = 0`
  write). The `yo fix --migrate mut-bindings` goldens are unchanged: the
  migration reads the raw parse.
