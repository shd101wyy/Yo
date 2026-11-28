# Two same-shaped recursive structs share one generic instance

**Severity:** S1 — a valid program does not compile. Two named recursive structs with the same fields
(`Node` and `BNode`, both `struct(value : i32, next : Option(Box(Self)))`) are confused: `Box(BNode)` is
served the `Box(Node)` instance, so the evaluator rejects the program or the C compiler rejects the emitted
code. It turned develop red on 56933fcd8 (`tests/local-borrows.test.yo` and `tests/send-sync.test.yo` failed
to compile on every leg and in the hollow sweep).

- Filed: 2026-11-28 by the `fix-develop-56933` lane.
- Introduced by #2123 (3259bf4a6, VERDICTS-77 PR 2); does not reproduce with the v0.2.80 seed.
- **Status:** fixed on `fix/develop-56933`.

## Reproducer

```yo
Node :: struct(value : i32, next : Option(Box(Self)));
BNode :: struct(value : i32, next : Option(Box(Self)));
main :: (fn() -> unit)({
  b := BNode(value : i32(1), next : .None);
  c := Option(Box(BNode)).Some(Box.new(b));
});
export(main);
```

```text
error: Cannot unify incompatible struct types: "BNode" and "Node"
  --> tmp/r2.yo:6:35
  |
6 |   c := Option(Box(BNode)).Some(Box.new(b));
  |                                   ^
```

With an `Arc(Mutex(Self))` back edge (`tests/send-sync.test.yo`'s `SsPeer` and `SsArcNode`) the evaluator
accepts the program and the two `Mutex` payloads get one `_MutexState` C type:

```text
error: incompatible pointer types passing '__yo_t_7745385219303133831 *' to parameter of type '__yo_t_18303320968428786949 *' [-Werror,-Wincompatible-pointer-types]
```

`Option(Rc(Self))` fails the same way. Two same-shaped recursive enums do not (`enum_decls_differ`).

## Root cause

A recursive struct's `Self` is a fieldless shell sharing the struct's id. `_compat_impl` resolves a shell to
the struct's registry final (`resolve_struct_shell`), and that final is built before the `::` binding stamps
the struct's name, so it has an empty `name`. Under the exact rule (the CTFE memo's identity), two nameless
structs with different ids fall through to the structural comparison, and the fields of `Node` and `BNode`
agree coinductively (the `next` fields meet the pair again, which the visited guard answers `true`). So
`Node` and `BNode` compared exact-equal whenever they were reached through a shell, as a type argument of
`Box`.

Before #2123 the stamped names of the two instances (`Box(<struct:…Node>)`, `Box(<struct:…BNode>)`) still
told them apart. #2123 made two instances of one constructor compare by their type arguments only, not by
their names (a substituted copy keeps the definition-era instance's name), which is right, but the type
arguments' comparison was the one that answered wrongly.

## Fix

`_struct_decls_differ` in `src/types/compatibility.yo`, the struct twin of `enum_decls_differ`: two
different `struct_decl_` ids (module-level declarations, keyed by source position) of which a `::` binding
named one (`type_binding_name`), with no type arguments and no constructor id, are two types. The exact
struct arm (identity, the CTFE memo's relation) applies it before comparing fields. Two anonymous records
and generic instances keep the structural rule, and flow is unchanged (an anonymous record with the same
fields still flows into a named struct, the `type-soundness` canary).

Test: the "Two same-shaped recursive structs" rows in `tests/recursive-enum.test.yo` (a `Box(Self)` pair and
an `Arc(Mutex(Self))` pair).
