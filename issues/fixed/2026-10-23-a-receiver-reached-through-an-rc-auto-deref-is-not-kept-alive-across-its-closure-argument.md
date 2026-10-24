# A `&Self` receiver reached through an `Rc` auto-deref is not kept alive across its closure argument, and E0910 does not check it

**Severity:** S1 — memory unsafety in accepted safe code: a closure argument that frees the receiver's `Rc` cell leaves the method reading freed memory (ASan heap-use-after-free).

**Status:** FIXED 2026-10-23 (branch `fix/s1-rc-receiver-alive`) — found by the
adversarial review of `RefCell.replace_with` (step 0 of
`issues/questions/2026-10-23-should-yo-add-a-flagless-cell.md`, #1554).

## Reproducer

`issues/repros/2026-10-23-a-receiver-reached-through-an-rc-auto-deref-is-not-kept-alive-across-its-closure-argument.yo`
(seed v0.2.68 and a develop tree binary, `--std-path ./std --optimize 2 --sanitize address --allocator system`):

```yo ignore
W :: struct(s : String);
impl(W, peek : (fn(self : &Self, act : &Impl(Fn() -> unit)) -> unit)({
  act();
  println(&self.s);
}));
hs := ArrayList(Rc(W)).new();
hs.push(rc(W(s : String.from("hello"))));
hs(usize(0)).peek(() => {
  hs.clear();
});
```

```
==…==ERROR: AddressSanitizer: heap-use-after-free on address … READ of size 8
```

Expected: either E0910 at the call, or `hello`.

## What is and is not affected

- The receiver position through an `Rc` auto-deref is the gap. The same lend
  as an argument, `peek_rc(&hs(usize(0)), () => { hs.clear(); })` with
  `peek_rc : (fn(w : &Rc(W), act : …) …)`, is rejected with E0910 (the
  closure's `hs.clear()` lends `hs` `&mut` while an earlier argument lends it).
- Without the `Rc` (`ArrayList(W)`, `hs(usize(0)).peek(…)`) the program
  prints `hello` with no ASan report: the receiver is a copy of the element.
- `RefCell(T)` reaches it the same way: `hs(usize(0)).with_mut(v => { hs.clear(); … })`
  over `ArrayList(Rc(RefCell(String)))` is a heap-use-after-free on develop,
  and so is `replace_with`. The access guard `_RefCellRelease` then writes the
  mark into the freed slot, and `replace_with`'s `_swap` reads the freed slot
  out as the returned old value. Their SAFETY comments in
  `std/sync/refcell.yo` cite this doc.

## Cause

Two independent gaps, both behind the method auto-dereference
(`src/evaluator/calls/function.yo`): on a payload hit the receiver argument is
replaced in place by the synthesized `w.*` (`make_deref_expr`), so every later
reader sees `hs(usize(0)).*.peek(...)`.

1. **No keep-alive.** A plain argument that is a borrowed counted projection
   gets Aliasing Stage 0's caller-owned +1
   (`set_expr_as_needs_to_call_dup_for_borrowed_projection`, gated by
   `arg_is_rc_projection_place`). The gate accepted a dot chain rooted at a
   name (`r.*`, `o.r`) or an index whose callee is one (`hs(i)`), and rejected
   every dot or deref chain rooted at an index (`hs(i).*`, `hs(i).r`,
   `hs(i).r.*`). Where it passed, the +1 was taken on the PAYLOAD, which is a
   no-op for a move-only payload (`RefCell(T)` owns a `Box`), so
   `with_mut`/`replace_with` over an `Rc` could never be kept alive. The
   written argument `peek_w(&hs(i).*, () => { hs2.clear(); })` and
   `RefCell(String).with_mut(&hs(i).*, ...)` had the same hole.
2. **No E0910.** `_call_lends` records a borrowed receiver as an unmarked lend,
   and `_check_call_lent_place_moves` checked an unmarked lend only when its
   place was a name or a field chain on one (`_is_plain_place_expr`, #1346),
   which rejects any `.*` step and any index. Since the auto-deref turns even
   `r.peek(...)` on a local `Rc` into `r.*.peek(...)`, every auto-dereferenced
   receiver fell out of the check, while the written `peek_w(&hs(i).*, ...)`
   (a marked lend) was E0910.

## Fix

Decision: the receiver is treated as the plain argument it stands for, which
gets BOTH protections today: decision 28's argument exclusivity (E0910) for the
conflict the call's own arguments can name, and Aliasing Stage 0's
caller-owned +1 for the conflict they cannot (an alias through a second
handle: `hs2 := hs; hs(i).peek(() => { hs2.clear(); })`, which no name-based
check sees). Choosing only E0910 would have left that alias form a
use-after-free; choosing only the keep-alive would have accepted the
name-visible conflict that its written `&` twin rejects. Decision 43's origins
do not change the picture: the receiver is a second-class `&Self` borrow of
the payload whose origin is the `Rc` cell, and the cell must outlive the call.

1. **The share goes on the handle** (`borrowed_place_read_only_handle`,
   `src/evaluator/utils.yo`; `consume_argument_for_parameter`,
   `src/evaluator/calls/helper.yo`). For a borrowed argument (the receiver
   included) whose place lies in an `Rc`/`Arc` payload, reached through `.*`
   and value-field steps (`hs(i).*`, `hs(i).r.*`, `o.xs(i).*`, a `Box` deref
   on the way), the +1 is taken on the nearest such handle, not on the
   payload. An `Rc`/`Arc` payload is read-only through the handle
   (decision 46, `handle_payload_is_read_only`), so the place changes only if
   the cell is freed, and the handle's +1 prevents exactly that; it works for
   a move-only payload. Any other cell on the way (a field of a `ref` object, a
   pointer deref) can be overwritten in place, so the walk stops there and the
   payload keeps its own share. A handle that is a bare name keeps today's
   rule (the binding holds it for the call, and E0910 below covers a closure
   that reassigns it). Stage 1's read-only-callee elision applies to the
   handle's dup as to a payload's (the marked node is now returned with the
   drop).
2. **Codegen emits it where the handle is dereferenced**
   (`generate_field_access`, `src/codegen/exprs/property_access.yo`): a `h.*`
   whose `h` carries a call-scoped share (`is_call_scoped_share_dup`) reads
   through the dup (`emit_deferred_dup_or_code`), so every call emitter, the
   state-machine paths included, takes the +1 before the call; the call's
   post-call drop releases it.
3. **The projection gate covers a field or deref after an element read**
   (`arg_is_rc_projection_place`): `hs(i).w` (a value field of an element) and
   `hs(i).*` under a `Box` are projections like `w.xs(i)`, so a copyable
   payload there gets its own +1.
4. **E0910 checks the receiver's place** (`_is_unmarked_lent_place`,
   `src/evaluator/calls/function.yo`): an unmarked lend (a borrowed receiver,
   an operator operand) is checked when its place is a name with field steps,
   dereferences and element reads on it, exactly as the written `&` of that
   place is. `hs(i).peek(() => { hs.clear(); })`, `r.peek(() => { r = ...; })`
   and `hs(i).with_mut(v => { hs.clear(); })` are E0910, and so is the value
   element form `xs(i).peek(() => { xs.clear(); })` (its `&xs(i)` twin already
   was). An element read is told from a method call by its callee's type.
5. **An exit from a later argument releases the share.** Points 1 and 2
   widened Stage 0's share to every handle reached through an `Rc` element or
   field. Its only release was the post-call flush, which a `return`, `break`,
   `continue` or unwind inside a later argument skips. That leaked the whole
   cell where develop leaked nothing. Fixed on the same branch:
   `issues/fixed/2026-10-24-a-caller-owned-share-leaks-when-a-later-argument-exits-early.md`.

## Verification

- `tests/rc.test.yo`: the auto-dereferenced, written-`.*`, `&`-argument,
  field-of-element, element-of-field, projection-call (`h.first().peek(...)`
  with `first : (fn(self : &Self) -> &Rc(T))`), `Rc(Rc(T))`, `Rc(Box(T))`,
  `Arc` and `io.async` forms over a payload with a destructor (each reports how many
  payloads were destroyed while its closure ran: 0); a `Box` element and a
  value field of an element with a `String` payload; the four E0910 forms.
  On the develop binary the E0910 test fails to compile its batch and every
  runtime test fails (an assertion, or ASan's heap-use-after-free).
- `tests/sync/refcell.test.yo`: `with_mut`, `with`, `replace_with` and
  `replace` over `ArrayList(Rc(RefCell(T)))` with the last other handle
  dropped inside the call, the `RefCell(T).with_mut(&hs(i).*, ...)` argument
  form, and the E0910 forms of `with_mut` and `replace_with`.
- The triage's shape matrix (a, e, g, h, i, x2, x3, x6, x7 and the Arc,
  nested and Box variants) prints `hello` under `--sanitize address`; the
  name-visible forms are E0910.

## Deferred

- A move-only element stored by value in a container (no `Rc`/`Arc` between
  them, e.g. `ArrayList(RefCell(T))` or `ArrayList(Box(RefCell(T)))`) that a
  closure frees through a second handle of the container: there is no counted
  handle to share and no +1 of the element, and E0910 cannot see the alias.
  Filed as
  `issues/2026-10-23-a-move-only-element-borrowed-for-a-call-is-freed-when-an-argument-clears-its-container-through-another-handle.md`.
- Found while triaging, unrelated to the receiver: an `Fn` closure that
  reassigns a by-value capture releases the old value twice
  (`issues/2026-10-23-an-fn-closure-that-reassigns-a-capture-releases-the-old-value-twice.md`).
