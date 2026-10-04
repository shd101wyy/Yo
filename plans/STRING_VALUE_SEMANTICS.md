# `String` is a value: copy-on-write semantics

**Status: APPROVED 2026-10-03. S0 landed (#1148); S1 (E0908 on `inout` writes
through a borrowed value) in review; S2–S4 not started.** Decision by the user, after
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

## 4. Mutating a copy: where writes go, and E0908

Under value semantics a write lands in the binding that is written:

- **A plain parameter** `fn(out : String)` is the callee's own copy. To change
  the caller's string, take `inout(out) : String` or return the new value.
- **A collection element** is mutated in place through its place:
  `xs(i).push_str("!")` already writes back (an index expression is a place
  `inout(self)` can write through), and so does `for(xs, inout(s) => …)`.
  `for(xs, s => s.push_str("!"))` changes a copy.
- **A struct field** is written through its place: `self.name.push_str(…)`.

**The rule: writing through a borrowed copy is E0908.** DESIGN says a plain
parameter is *borrowed* (an `inout` parameter is passed by reference, an
`own` one is moved in). E0908 "write through a borrowed value" already rejects
an assignment into a borrowed binding (a by-value parameter, a `match` or
`for` binding) whose old value holds reference-counted data:
`p.s = String.from("x")` is an error. The `inout` path skipped that check:
passing such a place to an `inout` parameter, or calling an `inout(self)`
method on it (`out.push_str("!")`), compiled. The write landed in the
borrowed copy alone, and a buffer it allocated was never released. 1,000
calls with an empty `String` leaked 33,000 bytes in 2,000 allocations on
v0.2.49.

**S1 extends E0908 to `inout` arguments and `inout(self)` receivers**, with
the same condition (the place's type holds reference-counted data) and the
same fix-it: take `own(x)` or `inout(x)`, or copy into a local and write the
copy. A non-reference-counted value (`struct(x : i32)`) stays writable as the
callee's local copy, as assignment already allows.

This replaces the warning this plan first proposed, for three reasons:
- it is an existing, documented rule, not a new lint;
- it catches every write through a borrowed `String`, including one whose
  copy is read afterwards, which a write-only lint would miss, and that case
  is exactly the code that relies on shared writes today;
- it closes the leak.

It is also the migration tool. Every site in `src/`, `std/` and `tests/`
that it rejects is code that relied on the shared write, and it is fixed
before the flip.

## 5. Phases

Each phase is one PR, merged on its local gates. A `std` or `src` change
runs the full local battery: check src/std, the fixpoint, gates_fast, the
fast suite, the hollow sweep.

- **S0: this document.** Also, the open issue's recommendation is corrected
  to value semantics, and the collections question is filed (§7) with its
  recommendation (values, as the next campaign).
- **S1: E0908 for `inout` writes through a borrowed value.**
  - Extend the check to `inout` arguments and `inout(self)` receivers (§4) on
    both call paths.
  - Fix every hit in `src/`, `std/` and `tests/` by taking `inout`/`own`,
    returning the value, or writing a local copy. Under today's semantics
    these fixes behave the same as before for the non-empty case and correctly
    for the empty one.
  - Tests:
    - the parameter, `for` element and `match` binding shapes are rejected;
    - `inout`, `own` and local copies are accepted;
    - a non-RC value type stays writable;
    - the leak repro is clean under ASan.
- **S2: count accuracy. DONE 2026-10-03** (`tests/rc.test.yo`, "COW S2").
  - **Measured:** a value type holding RC data (`struct(b : Box(i32))`, the
    shape `String` has) keeps an accurate live count in every position COW
    relies on. The dup/drop optimizer never cancels a value-with-RC pair
    ("both copies need their own drop"):
    - a nested-scope copy: 2 inside, 1 after;
    - a same-scope copy;
    - a callee's local copy of a parameter;
    - a list element;
    - a closure capture;
    - an async task slot.

    An overcount (a completed task still holds its copy until its scope ends)
    only costs an extra clone. An undercount, a count of 1 with two live
    copies, happens only for the reference-type alias elision
    (`b2 := b1` on a `Box`/`ArrayList` shares one count by design), and
    reference types never copy-on-write.
  - **Borrowed positions** (a by-value parameter, a `for` or `match` binding)
    share without a dup, so the count stays 1, but S1's E0908 forbids
    writing through them. Copy-on-write never meets them.
  - **Compile-time evaluation** builds no runtime `String` (`String.from` is a
    runtime value; comptime text is `comptime_str`), so copy-on-write never
    runs there.
  - **No compiler change was needed.** The test pins the property so a future
    optimizer change cannot silently break S3. When collections become
    values (`VALUES_BY_DEFAULT` V2) they fall under the same value-with-RC
    rule.
- **S3: copy-on-write in `String`.**
  - Add the uniqueness step to every mutator, and make `truncate`,
    `insert_str`, `insert`, `remove` and `pop` `inout(self)`. The step's
    clone goes through the shared buffer's owner, as `ArrayList.clone`
    does, not the current `with_allocator` scope (`VALUES_BY_DEFAULT`
    §3.11); a test writes to a copy of an arena-built string outside the
    scope and checks the clone's owner.
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
`issues/retired/collections-value-or-reference-semantics.md`, decided and folded into `plans/VALUES_BY_DEFAULT.md`. Its
migration is far larger: `src/` passes collections to helper functions that
mutate them throughout, and may hold one list in two places on purpose. It
needs its own measurements. It reuses everything this plan builds: S1's E0908 extension and S2's count guarantee apply to every value type, not
`String` alone, and S3's uniqueness step is the same helper.

## 8. Risks

- **A write that silently stops reaching the caller.** S1's E0908 extension
  rejects these before the flip; the fast suite and the fixpoint confirm
  behaviour.
- **Hidden O(n) on the first write to a shared buffer.** That is inherent
  to COW, and the price of independent copies. S3 measures it on the
  compiler.
- **Count accuracy is now semantic.** A count that reads 1 with two live
  handles makes a write leak into a supposedly independent copy. S2 is the
  defence, and it is a gate, not an afterthought.
