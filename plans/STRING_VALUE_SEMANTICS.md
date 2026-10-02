# `String` is a value: copy-on-write semantics

**Status: APPROVED 2026-10-03, phase S0 (this document) in review; S1–S4 not
started.** Decision by the user, after
`issues/a-write-through-a-string-copy-is-lost-when-the-string-was-empty.md`
(S1). This supersedes DESIGN §Type inference's "String is a
reference-semantics type", and is the fix for that issue. No backward
compatibility is kept (AGENTS.md): signatures change and call sites migrate.

---

## 1. The problem

`String :: newtype(_bytes : Option(ArrayList(u8)))`. A copy of a `String`
copies the handle, so its semantics today depend on hidden state:

```rust
append_copy :: (fn(out : String) -> unit)({
  out.push_str("!");
});
a := String.new();
append_copy(a); // a == ""    (empty: the copy allocated its own buffer)
b := String.from("hi");
append_copy(b); // b == "hi!" (non-empty: the copy shares b's buffer)
```

Nothing reports either outcome. The documentation disagrees with itself:
DESIGN §Type inference calls `String` "reference-semantics", while
`std/string/string.yo` describes a value that "owns heap bytes", whose
mutators take `inout(self)`, and whose empty value "allocates nothing". It
points to `std/imm/string` for sharing.

## 2. The model

| Type | Role | Copy semantics |
| --- | --- | --- |
| `str` | borrowed, read-only bytes (literals, views) | a view |
| **`String`** | **mutable text value** | **independent copies; the buffer is shared until one copy writes (copy-on-write)** |
| `StringBuilder` | shared mutable builder (`ref`) | reference |
| `std/imm/string` | immutable, atomically counted, crosses threads | shared, never mutated |

`String` behaves like `i32` or `Array(T, N)`: after `t := s`, nothing done to
`t` is visible through `s`, and the reverse holds too, whether or not `s`
was empty. This is Swift's `String`.

**Copy-on-write.** A copy is an RC dup of the buffer. A mutator first makes
the buffer unique: if `rc(buffer) > 1` it replaces its own `_bytes` with a
private clone, then writes in place. A unique buffer (the common case: a
string being built up by its only owner) is written in place with no copy.
`rc` is the live count (std/prelude's `Box` notes): the optimizer may cancel
a dup against the original's scope-end drop, which is a move, so a cancelled
pair never leaves two live handles at count 1. `Box`'s `can_isolate` already
relies on the same property.

**Empty stays free.** `String.new()` remains `.None` and allocates nothing.
The first write allocates in the writer alone, which is now exactly the
value-semantics outcome instead of a surprise.

**`clone()` becomes O(1).** It is a dup. The bytes are copied lazily, by
the first write to either side.

## 3. API changes (`std/string/string.yo`)

Every method that changes the bytes takes `inout(self)` and makes the buffer
unique first:

- **Already `inout(self)`:** `push_string`, `push_str`, `push_byte`,
  `push_rune`, `reserve`, `clear`. They gain the uniqueness step.
- **`self : Self` today:** `truncate`, `insert_str`, `insert`, `remove`,
  `pop`. They mutate the shared buffer, so they work only through the
  aliasing this plan removes. They become `inout(self)` with the uniqueness
  step.
- An audit in S3 covers every other `_bytes` write. Methods that build a new
  `String` (`to_uppercase`, `replace`, `+`, …) are unaffected.

Handing out or adopting the internal buffer would let a write bypass the
uniqueness step, so these change too:

| Today | Problem | Becomes |
| --- | --- | --- |
| `as_bytes() -> ArrayList(u8)` returns the internal list (252 call sites) | a caller's write to the list changes every `String` sharing it | removed, replaced by `to_bytes() -> ArrayList(u8)`, an independent copy (`as_`/`to_`/`into_`: `to_` costs a copy), and `into_bytes(own(self)) -> ArrayList(u8)`, which moves the buffer out with no copy when unique |
| `from_bytes(bytes : ArrayList(u8))` adopts the caller's list | the caller keeps a live handle to the string's bytes | `from_bytes(own(bytes))`: the list is moved in |
| `from_utf8(bytes)` | same | `from_utf8(own(bytes))` |

Read-only byte access, which most of the 252 `as_bytes()` call sites need,
uses what already exists: `len()`, `at(i)`, the `bytes()` iterator,
comparison, `hash`. A site that needs a list it may keep uses `to_bytes()`,
and a site that consumes the string uses `into_bytes()`. No `String`→`str`
view is added: `as_str()` was removed to close the dangling-view hole, and
that stays closed.

## 4. Mutating a copy: where writes go, and the warning

Under value semantics a write lands in the binding that is written:

- **A plain parameter** `fn(out : String)` is the callee's own copy. To change
  the caller's string, take `inout(out) : String` or return the new value.
- **A collection element** is mutated in place through its place:
  `xs(i).push_str("!")` already writes back (an index expression is a place
  `inout(self)` can write through), and so does `for(xs, inout(s) => …)`.
  `for(xs, s => s.push_str("!"))` changes a copy.
- **A struct field** is written through its place: `self.name.push_str(…)`.

The dangerous shape is a write whose result is never observed: a by-value
copy of a `String` (a parameter, a `for` element, a local copied from
another place) that is mutated and then neither read again nor returned nor
stored. **New warning (E-code allocated in S1):** "this writes the callee's
own copy of `out`, and the copy is never read; take `inout(out)` to change
the caller's string." It is a dead-store lint, so it has no false positives
on code that uses the copy afterwards. It applies to every value type with
`inout(self)` mutators, not only `String`.

The warning is also the migration tool. Code in `src/` and `std/` that
appends to a plain `String` parameter and relies on the caller seeing it
(true today for non-empty strings) is exactly what it reports. Every hit is
fixed under the current semantics, before the flip.

## 5. Phases

Each phase is one PR, merged on its local gates. A `std` or `src` change
runs the full local battery: check src/std, the fixpoint, gates_fast, the
fast suite, the hollow sweep.

- **S0: this document.** Also, the open issue's recommendation is corrected
  to value semantics, and the collections question is filed (§7) with its
  recommendation (values, as the next campaign).
- **S1: the dead-write warning.**
  - Implement it in the evaluator, with a registry entry and `yo explain`
    text, both languages.
  - Run it over `src/`, `std/` and `tests/`, and fix every hit by making the
    parameter `inout`, returning the value, or deleting the dead write. No
    semantic change yet; the fixes are correct under both semantics.
  - Tests: the warning fires on each shape in §4 and stays silent when the
    copy is read afterwards.
- **S2: count accuracy.** Tests that a live copy keeps `rc(buffer) >= 2`
  wherever COW must clone:
  - local + parameter; local + struct field; local + list element;
  - local + closure capture; local + async task slot; `for` element +
    collection;
  - a compile-time (CTFE) `String` mutated through a copy, because the
    evaluator interprets std's `String` and its count model must agree;
  - the canary for the known optimizer hazard (AGENTS.md: cancelling a
    dup/drop pair is unsound when the container does not outlive the local).

  Each counting defect found here is fixed before S3.
- **S3: copy-on-write in `String`.**
  - Add the uniqueness step to every mutator, and make `truncate`,
    `insert_str`, `insert`, `remove` and `pop` `inout(self)`.
  - Replace `as_bytes` with `to_bytes` / `into_bytes`, and give
    `from_bytes` / `from_utf8` `own`.
  - Migrate every call site in `std/`, `src/`, `tests/` and the docs.
  - `clone()` becomes a dup.
  - Regression test: the issue's program, and the `for` and parameter
    shapes, now print the value-semantics result for empty and non-empty
    strings alike.
  - **Measure** `yo check ./src` time and stage-2 compile RSS before and
    after (`--optimize 2`, no `--emit-c`), and re-baseline the memory
    ratchet if a number moves past ±10 %.
- **S4: docs and close.**
  - DESIGN §Type inference and §Writing through a copy of a `String`, en-US
    and zh-CN, STRINGS.md, and the pack's ownership section.
  - Move the issue to `issues/fixed/` with S3's test.
  - Update the `yo-core-patterns` / `yo-syntax` skills, re-recording the
    seven skill-tree goldens (memory note: skill edits move CLI goldens).

**Seed gate.** S3 is a `std/` change compiled by the seed. It uses only
`rc(...)`, `own(...)` and `inout(self)`, all present in v0.2.49. S1 is a
`src/` change.

## 6. What does not change (in this plan)

- `ArrayList`, `HashMap` and the other collections stay reference types
  until their own campaign (§7).
- `str` literals and `str` parameters.
- `std/imm/string`: still the type for sharing text across threads.
  `String`'s count stays non-atomic, and `String` stays non-`Send` wherever
  it is today.

## 7. Next: the collections become values too

The same half-value surprise exists one level up today:

```rust
Bag :: struct(n : i32, items : ArrayList(i32));
p := Bag(n : i32(1), items : ArrayList(i32).new());
q := p;
q.n = i32(2);           // p.n stays 1: the struct is a value
q.items.push(i32(7));   // p.items has 1 element: its list field is shared
```

**Recommended end state:** every std data type is a value with copy-on-write
(`ArrayList`, `HashMap`, `HashSet`, `Deque`, …), and sharing is always
explicit through a `ref` type, `Box(T)` or `Arc`. That is Swift's model.

- It makes the rule simple: a struct copy is a deep, independent value.
- It removes aliasing from the verifier's model. `requires(distinct(a, b))`
  (#1107) exists only because two list parameters can alias.
- It removes the most common action-at-a-distance bug from agent-written
  code.

It is a **separate campaign after this one**, filed as
`issues/questions/collections-value-or-reference-semantics.md`. Its
migration is far larger: `src/` passes collections to helper functions that
mutate them throughout, and may hold one list in two places on purpose. It
needs its own measurements. It reuses everything this plan builds: S1's
warning and S2's count guarantee are written for every value type, not
`String` alone, and S3's uniqueness step is the same helper.

## 8. Risks

- **A write that silently stops reaching the caller.** S1's warning exists
  to find these before the flip; the fast suite and the fixpoint confirm
  behaviour.
- **Hidden O(n) on the first write to a shared buffer.** That is inherent
  to COW, and the price of independent copies. S3 measures it on the
  compiler.
- **Count accuracy is now semantic.** A count that reads 1 with two live
  handles makes a write leak into a supposedly independent copy. S2 is the
  defence, and it is a gate, not an afterthought.
