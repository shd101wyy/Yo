# `Rc.get_mut`, `Rc.try_unwrap` and `Rc.make_mut` have no decided Yo form (OPEN-DESIGN)

**Kind:** design question — an open decision, not a defect. Filed 2026-10-10
from the `plans/backlog/RUST_REFERENCE_PATTERNS.md` audit (§6): neither
`std/prelude.yo` nor `plans/VALUES_BY_DEFAULT.md` names any of the three.

## The hole

Rust's three "get the payload back out of a handle" operations:

| Rust | Meaning |
| --- | --- |
| `Rc::get_mut(&mut rc) -> Option<&mut T>` | exclusive access iff the count is 1 |
| `Rc::try_unwrap(rc) -> Result<T, Rc<T>>` | the payload by value iff the count is 1, else the handle back |
| `Rc::make_mut(&mut rc) -> &mut T` | clone-on-write: clone the payload into a fresh unique cell if shared, then exclusive access |

They are how Rust code builds a shared tree, then edits or dismantles it
without a second allocation. Since decision 41 (2026-10-10) a write through
a plain `Rc(T)` compiles only where the summaries prove no borrow is live,
and the dynamic check is spelled `RefCell(T)`; so `get_mut` is no longer
redundant — it is the one way to write through a handle that is uniquely
held without paying for a `RefCell` in the type — and the gap is all three:
`get_mut`, **ownership recovery** (`try_unwrap`) and the **explicit
clone-on-write** (`make_mut`), which the plan's §0.1 dropped as an implicit
mechanism but never ruled on as a spelled operation.

## Options

1. **Nothing**: `rc.clone()` of the payload (a deep copy, always) and
   `drop` the handle. Pays a copy even when the count is 1.
2. **`Rc.try_unwrap(h) -> Result(T, Rc(T))`** only. Decision 19 forbids
   moving out of a live value, but a handle whose count is 1 is being
   consumed, so this is a move, not a partial move. `get_mut` is left to
   `RefCell(T)` (every mutable-through-handle payload pays the cell), and
   `make_mut` is `cond(Rc.is_unique(&h), h, rc(h.clone()))` written out.
3. **The Rust trio**: 2 plus `Rc.get_mut(mut(h)) -> Option(mut(T))` as a
   decision-24 projection (second-class, never stored) and
   `Rc.make_mut(mut(h)) -> mut(T)` which clones the payload when shared and
   yields the (now unique) place. The clone is explicit in the name, which
   satisfies §0.1's "no hidden copy" rule the way `Rc.clone` does.

## Recommendation

Option 3, with `Arc` mirrors, after V2b (when `Rc.clone` is explicit per
decision 17/32 and the clash error exists). `try_unwrap` is the piece the
compiler's own V4/V5 tree rewrites will want (unwrap a uniquely held
subtree instead of cloning it); `get_mut` is cheap (a count test plus the
mark acquire) and gives the verifier a place that is provably unshared;
`make_mut` is the one Rust idiom in this family with no honest substitute,
and its name is the copy's spelling. `Option(mut(T))` is a borrow inside a
type constructor and is rejected by decision 38 A, so `get_mut`'s result is
`mut(T)` with a panic on a shared cell, or the `Option` is replaced by an
`is_unique` predicate the caller tests first; the second form is
recommended.
