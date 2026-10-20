# The comptime cycle query misreads a list of a self-listing struct

**Severity:** S3 — `Type.can_form_rc_cycle(ArrayList(LS))` reads `false` for
`LS :: ref(struct(k : ArrayList(Self)))` although the emitted constructor of
that list registers with the cycle collector; only the introspection answer
is wrong, the generated program is right.

**Status:** open on develop; fixed by `de5ee94fc` on draft PR #1486
(`fix/linkedlist-managed-element-cycles`). It is a second symptom of
`issues/2026-10-18-a-linkedlist-of-managed-elements-forms-uncollected-cycles.md`
(see "Cause"). When #1486 merges, move this doc to `fixed/` with it.
**Found:** 2026-10-20 with the v0.2.66 seed, while probing
`issues/fixed/2026-10-20-a-ref-enum-cycle-through-a-ref-struct-is-never-collected.md`.
Still fails with the v0.2.67 seed.

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array_list");
LS :: ref(struct(k : ArrayList(Self)));
main :: (fn() -> unit)({
  s := LS(ArrayList(LS).new());
  comptime_assert(Type.can_form_rc_cycle(ArrayList(LS)), "q");
  ()
});
export(main);
```

`yo check` fails the assertion. The answer depends on what ran before it:

| Statements before the spelled query                                          | Answer  |
| ---------------------------------------------------------------------------- | ------- |
| none                                                                         | `false` |
| `s := LS(ArrayList(LS).new());`                                              | `false` |
| `s := ...; x := s.k;`                                                        | `false` |
| `l := ArrayList(LS).new();` and a query of `type_of(l)` (itself `false`)     | `false` |
| `s := ...;` and a query of `type_of(s.k)` (itself `true`)                    | `true`  |

`Type.can_form_rc_cycle(LS)` is `true` throughout, and so is
`Type.impls(ArrayList(LS), Acyclic) == false`. In codegen,
`ArrayList(LS)`'s constructor calls `__yo_gc_register`, and a cycle
`k.push(LS(k))` is collected.

## Cause

The self-declaration's shell, established by A/B rather than by a trace.
While `LS`'s body is evaluated, `Self` is an empty placeholder struct (the
shell), and a copy of it can survive inside a nested instantiation. A walk
that meets the shell sees a struct with no fields, a dead end, so the query
answers `false`. Codegen judges the list from the patched types and
registers it. Which copy of the shell this query meets was not traced.

It is the defect of
`issues/2026-10-18-a-linkedlist-of-managed-elements-forms-uncollected-cycles.md`,
where `LinkedList(Self)` reaches `Self` only through `Node(Self)`'s buffer.
The fix there, `de5ee94fc` on draft PR #1486 (the same patch, by
`git patch-id`, is `f0db6e64a` on `perf/acyclic-compiler-containers`), makes
`_type_refs_back_to_cyclic` resolve the shell through the finals registries
(`resolve_enum_shell(resolve_struct_shell(ty_in))`) before it matches.

Evidence (2026-10-21, `yo check` on the reproducer above):

| Binary                                                              | Result               |
| ------------------------------------------------------------------- | -------------------- |
| seed v0.2.67                                                        | `error: q`           |
| tree binary `d31c21c57` (this branch's enum-root fix)               | `error: q`           |
| `perf/acyclic-compiler-containers` at `2d15820e7`                   | `evaluator OK`       |

That branch's only other `src/` changes are `impl(AstExpr, Acyclic())`,
`impl(VcSort, Acyclic())` and `impl(VcTerm, Acyclic())` on compiler types, so
the shell resolution is the only change that can flip a user type's answer.
That an earlier `type_of(s.k)` query makes later answers agree is consistent
with that query patching the shell; it was not traced.

An earlier version of this doc guessed that the spelled list and the field's
list were distinct instantiations with distinct ids. Reading the walk rules
that out: after the re-root at `LS`, any `ArrayList(LS)` reaches `LS` through its
buffer, and the struct arm's visited guard answers `true` for it whatever
the list's id. Only a shell, with no fields to follow, gives `false`.

## Test

`tests/cycle_collector.test.yo`, "Type.can_form_rc_cycle reads a spelled
ArrayList(Self) instantiation as codegen does": a runtime `assert` on
`Type.can_form_rc_cycle(ArrayList(QNode))`. It fails with the v0.2.66 and
v0.2.67 seeds and with this branch's tree binary. It is red on develop until
#1486's shell resolution lands, so this branch should merge after #1486.
