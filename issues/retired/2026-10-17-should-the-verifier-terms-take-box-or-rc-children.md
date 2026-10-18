# Should the verifier's `VcSort` and `VcTerm` take `Box` or `Rc` children?

**Kind:** design question (decided; retired into the plan).

**Status:** DECIDED 2026-10-18: the recommendation is taken. The maintainer delegated the open VBD questions to the coordinator's advisor and accepted its verdicts. Filed 2026-10-17
while converting the V4 trees (`plans/VALUES_BY_DEFAULT.md` §6 V4), after
`Z3Sexpr` converted and `Pattern` was converted with `Box` children.

## The question

Decision 21 gives the four small trees `Box` children: `Pattern`, `VcSort`,
`VcTerm` and `Z3Sexpr`. `VcSort` and `VcTerm` (`src/verifier/terms.yo`) are
still `ref(enum)`. Converting them as decision 21 says runs into two things
that the other two trees did not have.

1. **They live in maps.** `src/verifier/vc.yo` keeps
   `HashMap(String, VcTerm)` (the variable environment `vars`, `entry_vars`,
   `call_pre`, the break-site and arm-state snapshots, the `old(...)`
   overlay) and `HashMap(String, VcSort)` (`array_sorts`, the declared-name
   collectors). A `VcTerm` with a `Box(Self)` child is move-only (`Box`
   implements `Drop`), and:
   - a `HashMap` of a move-only value did not compile before #1420
     (`issues/fixed/a-hashmap-of-a-move-only-key-or-value-does-not-compile.md`);
   - even with that fix, `HashMap.get` still returns `Option(V)` by copy, so
     each of the 49 `get`s in `vc.yo` that reads a term or a sort out of a
     map needs a borrowing accessor that does not exist yet (V2b's
     non-copying element access).
2. **Their sharing is the algorithm.** The symbolic walk snapshots the whole
   variable environment at every branch, loop exit and break, and merges
   the branches back as `ite(c, a, b)` terms built from both snapshots'
   values. With `ref` children a snapshot and a merge copy handles (one
   count bump per term). With `Box` children every snapshot and every merge
   deep-copies each term, and the terms grow with the walk (each merge
   nests the previous values). That is the pattern that made the value
   `TypeValue` 2.3× slower (decision 21's 2026-10-13 amendment), and it is
   the opposite of `Pattern` and `Z3Sexpr`, which are built once and read.

## Options

1. **`Box` children, as decision 21 says**, after V2b gives `HashMap` a
   borrowing `get` and move-only values. Every snapshot clones the map, and
   every merge clones the terms. This needs a measurement on
   `yo verify ./tests/spec` and the `tests/internal/verifier*` files before
   it lands.
2. **`Rc` children** (`VcTerm :: Rc(VcTermNode)` or `Rc(Self)` children),
   as `TypeValue` and `AstExpr` have. Terms are immutable after construction,
   so `Rc` shares them honestly (decision 21's argument for the large
   trees). This needs no collection work and keeps a snapshot O(map size).
3. **`Box` for `VcSort`, `Rc` for `VcTerm`.** Sorts are small and rarely
   copied (a declaration, a fundecl list), so the copy cost is negligible.
   They still sit in `HashMap(String, VcSort)`, so this waits for option 1's
   map work as well.

## Recommendation

Option 2 for `VcTerm`, option 3's `Box` for `VcSort` once maps can hold
move-only values. Amend decision 21 so the rule is "a tree whose algorithm
shares subtrees takes `Rc`, a tree that is built once and read takes `Box`",
and keep `Pattern` and `Z3Sexpr` as the `Box` and value cases. Until the
maintainer decides, both stay `ref(enum)`; `ref` goes away only at V5.

## Verdict

- **`VcTerm` takes `Rc` children now.** Spell it `VcTerm :: Rc(VcTermNode)` or give it `Rc(Self)` children. It needs no collection work, and a snapshot stays O(map size).
- **`VcSort` takes `Box` children after V2b** has given `HashMap` a borrowing accessor and move-only values (B6).
- **Decision 21 is amended** (`plans/VALUES_BY_DEFAULT.md` §4, decision 21):
  - a tree whose algorithm shares subtrees (snapshot and merge) takes `Rc`;
  - a tree that is built once and read takes `Box`;
  - a tree with no direct `Self` child is a plain value.
  `Pattern` is the `Box` case, `Z3Sexpr` the value case, and `TypeValue`/`AstExpr` the `Rc` case.
- Converting `VcTerm` is V4 work, measured against develop like the other trees (`yo verify ./tests/spec`, the `tests/internal/verifier*` files, `check ./src` time and stage-2 RSS).
