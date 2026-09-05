# `unit` should be a TRUE zero-sized type — `sizeof(unit)` must be 0, as in Rust

**Status: OPEN — design goal, owner-requested 2026-09-05.**
**Severity: language design + memory footprint**, not a correctness bug: the
tree is self-consistent today. This tracks a deliberate change of direction.

## The goal

`sizeof(unit) == 0`, and `unit` occupying no space anywhere — Rust's model:

```rust
size_of::<()>()            == 0
size_of::<[(); 1_000_000]>() == 0
// Vec<()> never allocates; HashSet<T> IS HashMap<T, ()> and the () is free
```

Yo reports **1 byte** as of 2026-09-05
(`issues/fixed/sizeof-of-aggregate-with-unit-field-disagrees-with-emitted-c-struct.md`,
PR #425): `get_size_of_type(.Unit)` is `8` bits, alignment 1.

## Why it is 1 today, and why that was right at the time

Yo emits C11 and **C has no zero-sized object type**. An earlier fix
(`issues/fixed/unit-typed-params-and-fields-emit-c-void.md`) made `unit` usable
in parameter, field, tuple and generic-container positions by spelling every
storage position as a one-byte `uint8_t` placeholder
(`get_storage_type_string`, `src/codegen/utils/index.yo:1385` — literally
`if(s == "void", "uint8_t", s)`).

`get_size_of_type` was never updated to match, so the layout model said 0 while
codegen emitted 1. `sizeof` folds to a C literal that sizes allocations which
C-typed pointer arithmetic then strides through, so `malloc(n * sizeof(S))`
under-allocated and every element past the first wrote **out of bounds** — a
heap overflow from ordinary safe code. Raising the size to match the emitter
was the smaller, safe fix and it removed the unsafety immediately. It was not a
verdict on the design.

**This issue reverses the direction.** The goal is to erase `unit` for real,
and make `sizeof` 0 again because nothing is emitted.

## Why this is more tractable than it looks

**C struct fields are accessed BY NAME, not by index.** `_emit_runtime_fields`
(`src/codegen/types/generation.yo`) emits `  ${type} ${fname};` and every
access is `s.fname`. So **removing a `unit` field shifts nothing** — there is no
positional index or offset arithmetic to repair. That was the main thing that
made erasure look expensive, and it is not true here.

**The erasure path already exists and is proven for one aggregate kind.**
`generate_enum_declaration` already emits **no member at all** for a `unit`
variant field, and emits no member for a variant whose fields are ALL `unit`.
`_variant_storage_field_types` (`src/types/utils.yo:1431`) exists precisely so
the size walk agrees with that erasure. The comment there names it "the single
exception to the one-byte-placeholder rule". **Enums erase `unit`; structs
materialize it.** This issue is the proposal to make structs behave like enums,
not to invent a new mechanism.

## What has to change

| site | today | wanted |
| --- | --- | --- |
| `get_size_of_type(.Unit)` (`src/types/utils.yo:1581`) | 8 bits | **0** |
| struct/tuple field (`_emit_runtime_fields`) | one-byte placeholder | emit **no member** |
| a read of a `unit` field | reads the dead byte | elide — the value is `unit` |
| a write to a `unit` field | guarded off in `src/codegen/exprs/assignment.yo` | keep eliding; the guards become unconditional |
| `unit` parameter | one-byte placeholder in the C signature | **drop the parameter** (Rust drops ZST args) |
| `unit` return | already `void` | unchanged |
| `Array(unit, N)` | tracked gap, spells bare `void` | **0 bytes total** |
| `ArrayList(unit)` | mallocs `1 * capacity` | **never allocates** (Rust `Vec<()>`) |
| `dyn` vtable `unit` members | tracked gap | erase |
| async state-machine `unit` slot | tracked gap | no slot |
| module-level `unit` global | tracked gap | no storage |

### The one genuinely hard case: an all-`unit` aggregate

`struct(a : unit, b : unit)` would have **no members**, and a member-less
`struct {}` is a GNU extension, not standard C11. Rust says
`size_of::<EmptyStruct>() == 0`. Options, in preference order:

1. **Do not emit the C type at all** and represent the value as a compile-time
   token, the way the enum path already handles an all-`unit` variant. Cleanest,
   matches Rust, and reuses a mechanism that exists.
2. Emit a one-byte dummy for the *aggregate* while its *fields* are zero-sized.
   `sizeof` would then be 1 for the aggregate and 0 for `unit` — self-consistent
   and safe, but it is not Rust parity and it would need saying out loud.

Option 1 is the goal; option 2 is the fallback if a value of such a type must
be materializable (address-taken, passed by pointer, stored in a container).
**Decide this before touching anything else** — it determines whether
`&empty_struct_value` is expressible at all.

## Conflict with an existing issue — read this first

`issues/unit-zst-residual-gaps.md` lists seven uncovered sites and prescribes,
for each, "route it through `get_storage_type_string`" — i.e. **give it the
placeholder**. That is the opposite of this issue. Its own note says the layout
model "already ASSUMES the placeholder at every one of these sites".

**Every site fixed that way makes this issue more expensive**, because it adds
another place that must later be un-done. Whoever picks up either issue must
reconcile them first. If ZST parity is the accepted direction, then
`unit-zst-residual-gaps.md`'s seven rows should be re-prescribed as *erasure*
sites and the two issues merged.

## Cost worth stating plainly: `sizeof(unit)` churns 0 → 1 → 0

It was 0 (wrongly — the emitter disagreed), is 1 as of v0.2.25, and this issue
makes it 0 again (rightly — nothing is emitted). A user watching the `size_of`
builtin sees it move twice. There was no way to avoid the interim: the heap
overflow was live and had to be fixed in that release, and true ZSTs are far
too large a change to have ridden along. The way to keep the cost small is to
land this **soon**, so the 1-byte window spans as few releases as possible.

Both moves are user-visible changes to a comptime value and each needs a
release-note breaking-change entry.

## Verification

The hazard is the mirror image of the bug that produced the 1: the layout model
and the emitter disagreeing. So the gate is a **differential** one, not a
`sizeof` assertion.

- For every shape in the table above, assert `sizeof` against the ACTUAL emitted
  layout — allocate an array of N, write a distinct sentinel to each element,
  read them all back. A `sizeof` equality alone cannot catch an emitter-side
  change. `tests/unit_as_value_type.test.yo` (added by #425) already does this
  for five shapes and is the template.
- `Array(unit, N)` and `ArrayList(unit)` must not allocate, and `push`/index
  must still behave. Watch for division or multiplication by a zero element size
  in the container code — that is where a real ZST implementation usually
  breaks (Rust special-cases it in `RawVec` for exactly this reason).
- `HashMap(K, unit)` as a set — a byte per entry today, zero after.
- `MallocScribble=1 MallocPreScribble=1 MallocGuardEdges=1` on every probe, plus
  `leaks --atExit`. NOTE: `--sanitize address` does NOT instrument on macOS
  (zero `__asan` symbols); ASan's crash detection IS armed on Linux CI.
- `yo build` self-compile plus stage-2/stage-3 fixpoint: struct layout is ABI,
  and the compiler compiles itself.
- An emit-diff over the corpus: nothing that contains no `unit` may change a
  single byte.

## Prior art to copy from

Rust's ZST rules are the specification to match: alignment stays meaningful
(`()` is align 1), ZSTs are still *values* with a type, `&ZST` is a valid
non-null dangling-but-aligned pointer, and containers special-case a zero
element size rather than dividing by it. The last one is the practical trap.
