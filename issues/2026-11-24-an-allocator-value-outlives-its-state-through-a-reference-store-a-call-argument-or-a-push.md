# An `Allocator` value outlives its state through a reference store, a call argument or a push: the raw-pointer flowability gate checks only assignments, field stores and returns

**Severity:** S1: a safe file (no pragma) allocates through an `Allocator` whose state has left scope, a stack-use-after-scope under ASan, when the allocator comes from an `AllowUnsafe` module of the address-as-`ctx` shape `plans/reference/ALLOCATOR_PLACEMENT.md` §11.1 describes; std itself mints no such `Allocator`, so a program of safe files and std alone does not reach it.

Found 2026-11-24 by the VERDICTS-79 consultation (Fable, its probes `t2/e3` and `t2/e6` on the `261411ced` binary); reproduced for this document on develop `34359627e` (tree binary built with `--std-path ./std`, run inside `nix develop`, `--cc clang`).

## Reproducer

`issues/repros/2026-11-24-an-allocator-value-outlives-its-state-through-a-reference-store-a-call-argument-or-a-push/`:
`counting.yo` is the allocator module (it needs `pragma(Pragma.AllowUnsafe)`); every other file is safe. The
allocator, reduced from §11.1:

```yo
pragma(Pragma.AllowUnsafe);
{ GlobalAllocator } :: import("std/allocator");
{ assert } :: import("std/assert");
Counting :: struct(live : usize);
_alloc :: (fn(ctx : ?*void, size : usize, align : usize) -> ?*void)({
  s := (*Counting)(ctx.unwrap());
  unsafe(s.*.live = (s.*.live + usize(1)));
  GlobalAllocator.aligned_alloc(align, size)
});
_realloc :: (fn(ctx : ?*void, ptr : ?*void, old_size : usize, new_size : usize, align : usize) -> ?*void)(.None);
_free :: (fn(ctx : ?*void, ptr : ?*void, size : usize, align : usize) -> unit)({
  s := (*Counting)(ctx.unwrap());
  unsafe(s.*.live = (s.*.live - usize(1)));
  GlobalAllocator.aligned_free(ptr);
});
_VTABLE := AllocatorVTable(alloc : _alloc, realloc : _realloc, free : _free);
impl(
  Counting,
  new : (fn() -> Self)(Counting(live : usize(0))),
  allocator : (fn(self : &mut Self) -> Allocator)(
    Allocator(ctx : .Some((*void)(addr_of(self.*))), vtable : addr_of(_VTABLE))
  ),
  Drop(drop : (fn(self : &mut Self) -> unit)(assert(self.live == usize(0), "Counting dropped with live blocks")))
);
export(Counting);
```

The smallest safe caller, `reference-store.yo`:

```yo
{ Counting } :: import("./counting.yo");
main :: (fn() -> unit)({
  mut(stale) := Allocator.global();
  {
    mut(c) := Counting.new();
    r := &mut stale;
    r.* = c.allocator();
  };
  b := Box.new(i32(7), alloc : .Some(stale));
  _ := b;
});
export(main);
```

`yo check` passes (rc 0). Compiled with `--sanitize address --allocator system --cc clang` and run (rc 1):

```text
==3378539==ERROR: AddressSanitizer: stack-use-after-scope on address 0x7bffb31ff040 at pc 0x5555556774a5 bp 0x7bfff3bfe960 sp 0x7bfff3bfe120
READ of size 8 at 0x7bffb31ff040 thread T1
Address 0x7bffb31ff040 is located in stack of thread T1 at offset 64 in frame
  This frame has 3 object(s):
    [32, 48) '__yo_v_stale'
    [64, 72) '__yo_v_c' <== Memory access at offset 64 is inside this variable
SUMMARY: AddressSanitizer: stack-use-after-scope (.../reference-store+0x1234a4)
```

The read is `_alloc`'s `s.*.live` through the `ctx` that names `c`, whose block has ended.

### The four routes (same tree)

| File | Route out of `c`'s scope | `yo check` | Run under ASan |
| --- | --- | --- | --- |
| `assignment.yo` | `stale = c.allocator()` | rejected: "Assigning to 'stale' (type 'Allocator') a value that carries a raw pointer in its representation; the value must be rooted in storage that outlives 'stale'. The assigned expression is not flowable" | not compiled |
| `reference-store.yo` | `r := &mut stale; r.* = c.allocator()` | rc 0 | stack-use-after-scope (above) |
| `call-argument.yo` | `fill` passes `c.allocator()` to `set(dst : &mut Allocator, a : Allocator)`, which stores `dst.* = a`; `main` then allocates through `stale` | rc 0 | `stack-use-after-return`, READ of size 8 inside `fill`'s `'__yo_v_c'` |
| `push.yo` | `keep.push(c.allocator())` into an `ArrayList(Allocator)` declared outside the block | rc 0 | `stack-use-after-scope`, READ of size 8 inside `'__yo_v_c'` |

Returning the value (`get :: (fn() -> Allocator)({ mut(c) := Counting.new(); c.allocator() })`), assigning
`.Some(c.allocator())` to an outer `Option(Allocator)`, and wrapping it in a returned struct are all rejected
by the same gate (VERDICTS-79's `t2/main`, `e1`, `e5`). So the gate is meant to stop this flow, and stops
it only at three syntactic sites.

### Why std alone does not reach it

A safe file cannot mint an `Allocator` that names its own storage, nor copy one's words:
`Allocator(ctx : .Some((*void)(addr_of(x))), vtable : g.vtable)` is "Raw pointer types ('*(void)') are not
available in safe code", and `Allocator(ctx : g.ctx, vtable : g.vtable)` is "Raw pointer values are not
available in safe code: '(g.ctx)' has type '?(*(void))'" (both on the `261411ced` binary). std mints only
`Allocator.global()` (`ctx` `.None`, a static vtable, `std/allocator.yo`) and copies of a live block's own
owner prefix (`std/allocator.yo`, `std/prelude.yo`). Every `Allocator` whose `ctx` can dangle is therefore
made in an `AllowUnsafe` file. The only such std allocator, `std/arena`, was deleted 2026-10-24, and it used
generation-stamped tickets, not addresses.

## Root cause

The gate (`type_representation_contains_raw_ptr` with `is_flowable_expr`, `src/types/flowability.yo`) runs at
four sites, all in safe files: the `name = rhs` reassignment and the `holder.f = rhs` / `arr(i) = rhs` store
(`src/evaluator/exprs/assignment.yo`), a `return(...)` (`src/evaluator/exprs/begin.yo`) and a function's final
expression (`src/evaluator/calls/function-type.yo`). Three gaps let the value past it:

1. **A store through a reference is rooted at the reference.** The field/element store takes the container's
   lifetime from the frame level of the access chain's root binding (`get_root_expr_of_field_access`). For
   `r.* = v` that binding is the reference `r`, declared in the same block as `c`, not the place `r` names
   (`stale`, one block out). `c.allocator()` is a same-frame local source at `r`'s level, so it is accepted.
2. **Every by-value parameter is a flowable source** (`allow_parameter_source : true` at every site; the
   message lists "a non-'ref' parameter"). The rule assumes a parameter's value is rooted in the caller's
   storage, which is the hazard itself: in `set`, `dst.* = a` stores a parameter, so it passes, while the
   caller `fill` handed over a value naming its own frame.
3. **A call argument is never checked.** Neither `set(dst, c.allocator())` nor `keep.push(c.allocator())` is a
   gate site. `ArrayList.push` stores its argument from std's `AllowUnsafe` code, which the gate exempts.

`Allocator` is the one raw-pointer-carrying type a safe file can hold (the parameter gate makes it opaque,
`parameter_type_contains_raw_ptr`, `src/types/utils.yo`, for `alloc : Option(Allocator)` placement), so these
gaps matter for `Allocator` only.

## Fix options

1. **Close the three gaps in the gate.** Root a store through `r.*` at the referent's place; stop treating a
   by-value parameter as rooted; check call arguments against everything the callee can reach. The third is
   the problem: a rooted-flow rule without an origin on `Allocator` cannot tell `Box.new(v, alloc :
   .Some(c.allocator()))` (the intended use; the block keeps the `Allocator` in its prefix and may outlive `c`
   too, VERDICTS-79 hazard 1) from `keep.push(c.allocator())`. It would reject placement itself or stay
   partial.
2. **An origin on `Allocator`.** Makes every route a borrow-check error; VERDICTS-79 rules it out (`Allocator`
   is escapable by design and is stored in every placed block's prefix).
3. **Make the dangling `ctx` impossible instead of unflowable.** VERDICTS-79 Q1 (adopted): std's allocators keep
   their state in an immortal slot table and put a ticket (slot index + generation) in `ctx`, so a stale
   `Allocator` panics on its next call and never reads freed memory. Then: the gate gains nothing for std, and
   `Allocator` leaves it (VERDICTS-79 follow-up 1); the user-allocator pattern of §11.1 and of
   `docs/en-US/EXPLICIT_ALLOCATORS.md` ("Writing your own allocator") is rewritten on the public form of that
   table (follow-up 3), or, until it exists, documents that an address-as-`ctx` allocator must not hand its
   `Allocator` to code that can outlive the state.

## Recommendation

Option 3; it is the adopted direction. For v0.2.80, which ships no `std/heap`: state the boundary in
`docs/en-US/MEMORY_SAFETY.md` and `docs/en-US/EXPLICIT_ALLOCATORS.md` (and zh-CN). Today they say only "a
user-written allocator's context and vtable must stay valid until every block it handed out is released";
the reproducer allocates after the context died, with no block handed out before, which that sentence does
not cover. The release's soundness claim is then "safe code plus std", which holds without A1. The closing
test is `call-argument.yo`'s shape against A1's `FixedBufferAllocator` (VERDICTS-79 test row 12): the
stale-ticket panic with no ASan report.
