# `yo fix --migrate explicit-copy` misses a write through a local the copy was moved into

**Severity:** S1. The rewrite changes what the program computes. A list copied into one local and then stored in a second local stops reaching its source when the program pushes through the second local.

> Found 2026-10-23 by the adversarial review of `fix/explicit-copy-s1-tool-defects`
> (the branch that fixed
> `issues/fixed/2026-10-22-explicit-copy-migration-clones-a-conditional-arm-whose-binding-is-written-afterwards.md`).
> The defect predates that branch: the 3cb59050d tool behaves the same.

## Symptom

The written-after guard lists a copy when the program writes its source or
its destination afterwards. `t := e.no; t.push(v)` is listed, and so is
`t := if(c, e.no, e.yes); t.push(v)` since the conditional-arm fix. The guard
does not follow a copy past its first destination, though:

```yo ignore
x := entry.no;          // the copy: `entry.no` shares its buffer with `x`
mut(target) := x;       // `x`'s last use: a move, so no copy site
target.push(v);         // reaches `entry.no` through `x`'s buffer
```

The migration rewrites the first line to `x := entry.no.clone()`, so the push
lands in a fresh list. The same happens when the copy reaches the written
local through a block tail or a conditional arm that ends in a local
(`t := { x := entry.yes; x }`, `t := if(c, { x := entry.no; x }, entry.yes)`),
through an assignment (`target = x`), and on the source side:

```yo ignore
snapshot := list;       // the copy, `list` read again
mut(target) := list;    // `list`'s last use: a move
target.push(v);         // `snapshot` sees the push today
```

That rewrite gives `snapshot := list.clone()`. The documented residual (a
copy written after it left the function, was stored in a field, passed by
value or returned) does not cover a store into another local of the same
function.

## Reproducer

`issues/repros/2026-10-23-explicit-copy-migration-misses-a-write-through-a-local-the-copy-was-moved-into.yo`.
As written it prints `3 2 2 2`. `yo fix <file> --migrate explicit-copy` with the
pre-fix tool (`fix/explicit-copy-s1-tool-defects` at c97bfa20f) reports
`inserted 6 \`.clone()\` call(s); 1 site(s) left as written`, and the
migrated program prints `1 0 1 0`.

## Root cause

`_copy_written_after` (`src/main.yo`) judges a site against the writes of
exactly two declarations: the copy's source root (`src_decl`) and its
destination (`dst_decl`, or the destination of the result position it sits
at). Nothing records that a variable's value is later stored in another
variable, so a write through that second variable is invisible to the guard.
A move makes no copy site at all, so the store `target := x` leaves no trace
the driver can use.

## Fix

Fixed 2026-10-23 on `fix/explicit-copy-s1-tool-defects`. The guard now
follows the copy's source and destination into every variable they are
stored in after the site.

- `record_copy_tail_dests` (`src/evaluator/utils.yo`) already walked a
  store's result positions for the conditional-arm fix. It now walks every
  position: the stored expression itself and, nested, each block tail and
  arm body. At each one whose value is a place rooted in a local variable
  (`x`, `x.f`, `xs(i)`; `_ic_place_root_var`, which stops at a call's own
  result) it records a flow (`CopyFlow`) from that variable into the store's
  destination. Every binding, assignment and capture-list entry reaches it
  through `set_expr_as_needs_to_call_dup`, before any early return, so a
  move (no copy site) records its flow too.
- `_decl_written_after` (`src/main.yo`) judges a declaration against its
  own writes and then follows the flows recorded after the site,
  transitively and in the same module, judging each variable they reach.
  The driver applies it to the destination, to each result position's
  destination, and to the source. A store of the source into a local that
  is written afterwards (`snapshot := list; t := list; t.push(v)`) lists the
  copy into `snapshot`.
- The direct reasons are printed first ("its source" or "the copy" is
  written, then a result position's destination), and the flow-based ones
  after them, so an arm copy keeps the more specific reason.

A flow is field-insensitive, like the guard's writes: `t := e.yes;
t.push(v)` also lists an earlier `a := e.no`. That errs on the side of
listing. Field- or element-precise flows would need a per-path key.

| | `yo fix <repro> --migrate explicit-copy` | migrated program prints |
| --- | --- | --- |
| before (c97bfa20f, the previous head) | `inserted 6`, 1 listed | `1 0 1 0` |
| after | `inserted 1` (`peek`, whose local is never written), 6 listed | `3 2 2 2` |

## Test

`tests/cli-cases/fix-migrate-explicit-copy-moved-into-local` runs the
reproducer: a straight-line move, a block tail, an arm that is a block
ending in a local, an assignment, a source moved after the copy, and a
control (`peek`) whose local is never written. A trailing `build run` runs
the migrated program. The goldens expect six sites listed, one inserted,
and `3 2 2 2`. With the pre-fix binary the case is GOLDEN-DIFF.
