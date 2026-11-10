# S1d: a fat `*Dyn`/`&mut Dyn` lowering contradicts generic `*T` code at the sized `Dyn` alias

**Kind:** design question (decided; retired into the plan).

**Status:** DECIDED 2026-11-10 (VERDICTS-43, adopted by the coordinator): the recommendation below is accepted. The fat `*Dyn`/`&mut Dyn` lowering, raw `dyn(p : *V)` and `drop_in_place` through the vtable land in S2's flip PR. In S1 a `dyn(&v)` reference is a temporary of its statement: legal as a direct call argument only; returning, binding or storing it is E0912/E0911, and overlapping it with another lend of `v` is E0910.

VERDICTS-40 amendment 5 lowers a pointer to a `Dyn` as the registered fat struct `{data, vtable}` in every position, while trap 3 keeps a `Type` binder instantiated at `Dyn` legal in S1 (`type_is_sized(DynT)` stays `true`). The two cannot both hold: generic code such as `mem` swap/replace and `match` reference bindings instantiated at `T = Dyn` dereferences `*p` as the struct, and with a fat `*Dyn` that is invalid C. Measured on the S1d branch: 56 of `tests/dyn.test.yo`'s rows failed to compile (`initializing 'Dyn' with an expression of type 'Dyn *'`, `used type Dyn where pointer type is required`).

S1d therefore keeps the legacy lowering (a `&Dyn` slot by value, a `&mut Dyn` slot and a local borrow a pointer to the fat struct) and holds `dyn(&v)`/`dyn(&mut v)` in a frame temp. That is sound for a call argument or a local, and unsound only if such a reference is returned out of its frame. Raw `*Dyn` (`dyn(p : *V)`) and `drop_in_place` through the vtable are not built: with the sized alias `drop_in_place(*Dyn)` is today's `___drop`, the legacy release, and routing it through the vtable's `drop_in_place` would leak the legacy cell of every `ArrayList(Dyn)` element.

## Recommendation

Land the fat `*Dyn`/`&mut Dyn` lowering, raw `dyn(p : *V)` and `drop_in_place` through the vtable in S2's flip PR, where `type_is_sized(DynT)` becomes `false` and a generic `*T` at `Dyn` is E0619. Until then S1d's reference kinds (`dyn(&v)`, `dyn(&mut v)`, `downcast`/`upcast` through a reference, `size_of_val`/`align_of_val`) are final in type and semantics and temporary only in lowering.
