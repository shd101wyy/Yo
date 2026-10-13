# `Clone.clone` and `ToString.to_string` take `self : &mut Self`, so an element read through `&` cannot call them after the `Index` split (DECIDED)

**Kind:** design question: an open decision, not a defect. Filed 2026-10-13
by the V2b "Projections first" work (`plans/VALUES_BY_DEFAULT.md` V2b,
branch feat/vbd-v2b-index-mut, Generation B draft
feat/vbd-v2b-index-mut-genb).

**Verdict (2026-10-13):** Option 1, as recommended. `Clone.clone` and
`ToString.to_string` take `self : &Self`, and the sweep landed with it:
every impl in `std/`, `src/` and `tests/` that spelled the receiver, the
`derive(Clone)` rule's `Deref`-field spelling (`(type_of(self.f) <:
Clone).clone(&self.f)`), the call sites that lent `&mut` to an applied
`Rc(i32).clone(...)`, and the instruction, cheatsheet and user docs. The
`derive(Clone)`, `derive(ToString)` and `derive(Error)` rules write an
unannotated `self -> ...` member, so they take the trait's new mode with no
edit (the `Box` and `Rc` impls already spelled `self : &Self`, #1328); `x.clone()`
on a `Copy` type expands to `x` and has no receiver. The prelude's primitive,
`str` and raw-pointer clones were `self -> __yo_return_self(self)`. That
builtin is inlined as `(*arg)`: it assumes the receiver arrives as a pointer,
which a `&mut Self` receiver did and a `&Self` receiver of a scalar does not
(it is passed by value). The v0.2.59 seed compiled the compiler to C that
dereferenced a `u8`/`usize` (`(*__yo_v_item)` in `ArrayList(u8).clone`,
`(*__yo_v_self.__yo_v_row)` in a derived clone), so those bodies are now
`self -> self`, a plain copy out of the borrow, and `__yo_return_self` has no
caller left. No body
mutated its receiver: the two channel `Sender` clones count a new sender in
the shared channel record behind `self._ch`, which is not a write of the
receiver. `StringBuilder.to_string`, which does detach the buffer, is an
inherent method rather than the `ToString` member, and keeps `self : &mut
Self`. One premise below was wrong: a user impl that keeps `self : &mut Self`
did NOT get a mode-mismatch error, since receiver forms are free in trait
conformance. That gap let a call through `&Dyn(Trait)` write through a
read-only borrow; it is now an error at the impl
(`issues/fixed/an-impl-may-write-a-receiver-its-trait-lends-read-only.md`).
`Hash.hash` also takes `self : &mut Self` while only reading it, so it has
the same hole after the `Index` split; it is not part of this decision.

## The hole

Once std's `Index` is the read projection `self : &Self -> &Self.Output` and
`IndexMut` is the write half (decision 34, V2b Generation B), every use of
`x(i)` that needs the element mutably dispatches `index_mut`. A method call
on the element is such a use when its receiver is `self : &mut Self`. Two
prelude traits that only read their receiver declare it mutable:

- `Clone.clone : (fn(self : &mut Self) -> Self)` (`std/prelude.yo`);
- `ToString.to_string : (fn(self : &mut Self) -> String)`
  (`std/fmt/to_string.yo`).

So `keys(i).clone()` or `body(i).to_string()` on a container reached
through a `&` borrow (a `&T` parameter, a `match` binding over `&Self`) is
E0908 under the Generation B std. The container is read-only, and the call
asks to write it. Checking the Generation B draft std with the tree compiler
finds the first sites at once: `std/encoding/json.yo`
`_json_clone` (`keys(i).clone()`), and `std/http/wire.yo` `dechunk`
(`body(i).to_string()`, twice). There are more behind each module's first
error.

Sizes, by `(fn(self : &mut Self` at the impl:

| | std | src | tests |
| --- | --- | --- | --- |
| `to_string` impls | 42 | 3 | 8 |
| `clone` impls | 8 | 4 | 5 |

Plus the impls `derive` generates.

## Options

1. **Switch both receivers to `self : &Self`**, as Rust's `Clone::clone(&self)`
   and `ToString::to_string(&self)` are. Every impl spells the trait's modes
   exactly, so the sweep rewrites every impl, the `derive` generators, and
   the docs together. A body that mutates its receiver today has to stop
   doing so. That is the point: a clone or a rendering does not change its
   source. Nothing in the sweep needs a compiler feature the v0.2.59 seed
   lacks, so it can land before Generation B and make the switch smaller.
2. **Copy the element first at each site** (`k := keys(i); k.clone()`).
   This is a workaround per call site, and it reads the element twice for
   `Clone`. Every user tree hits the same error.
3. **Exempt these traits from the write promotion.** This is unsound: a
   `&mut Self` receiver may write, and the promotion exists to route that
   write through `IndexMut`.

## Recommendation

Option 1, as its own PR before the V2b Generation B std switch, and a
prerequisite of it:

- `Clone.clone` and `ToString.to_string` take `self : &Self`;
- the sweep covers std, src, tests, the `derive` impls and the docs;
- `yo fix` carries nothing, because a user impl that keeps `&mut Self` gets
  the existing mode-mismatch error naming the trait's spelling.

While the sweep runs, audit the other prelude receivers the same way.
`Hasher.write*`/`finish` and `Iterator.next`/`next_back` really do write their
receivers, so they stay `&mut Self`.
