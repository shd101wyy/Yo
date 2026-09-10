# Match-arm binding shadowing the scrutinee emits a self-referential C initializer (UB)

- **Status**: FIXED 2026-09-09 — develop `1d4023b0d` (#527): `_emit_pattern_binding_decl` hoists the initializer into a `__yo_pat_<bind>` temp at all five emission sites; regression tests in `tests/internal/match_binding_shadow.test.yo`.
- **Found**: 2026-09-09, during V3 of `plans/backlog/FORMAL_VERIFICATION.md` (match/datatype encoding)
- **Severity**: high — undefined behavior in generated C; nondeterministic garbage pointers, premature frees, rc=139 SIGSEGV
- **Surface**: any Yo `match` whose arm pattern binds a name that is also the scrutinee's name (or, generally, any name referenced by the binding's initializer)

## Reproducer

```rust
V :: ref(
  enum(
    Leaf(v : i32),
    Node(name : String, t : Self),
    Other
  )
);

walk :: (fn(t : V) -> i32)(
  match(
    t,
    .Leaf(v) => v,
    // `t` shadows the parameter `t`.
    .Node(_, t) => walk(t),
    .Other => i32(-1)
  )
);
```

The emitted C (v0.2.29 seed) is:

```c
static inline int32_t yo_id_N(__yo_t0* t) {
  switch (t->tag) {
  case __YO_T0_NODE: {
    __yo_t0* t = t->data.Node.t;   // <-- self-referential
    ...
```

## Root cause

In C, a declaration's point of declaration is **after the completion of its
declarator and before its initializer** (C11 6.2.1p4). So in
`__yo_t0* t = t->data.Node.t;` the `t` in the initializer refers to the NEW,
not-yet-initialized `t`, not the outer parameter. The expression therefore
reads an uninitialized stack slot — undefined behavior. The Yo codegen
emitted this form whenever an arm's pattern binding had the same sanitized
C name as the identifier chain in the binding's initializer (in practice:
the scrutinee).

Whether the program crashes depends entirely on clang's stack-slot
assignment for that particular function — which is why this presented as
*nondeterministic* corruption:

- The V3 verifier's `_collect_declared` (a 6-arm recursive walk over
  `VcTerm`, parameters `t : VcTerm`) crashed at `switch (t->tag)` reading
  address `0x38` (NULL + the box tag offset). Under gdb the "scrutinee"
  was a stale stack pointer into an ancestor frame; `Test.t` read as a
  valid pointer in one run and garbage in another at identical addresses.
- `yo test tests/internal/verifier_match.test.yo` and the standalone
  `tmp/matchdrv.yo` driver both reproduced rc=139, with and without ASan
  (the read stays inside the same stack page, so ASan sees a plain SEGV).

## Disassembly proof

In the miscompiled function, clang assigned the parameter `t` to frame
slot `0x200` (prologue `mov %rdi,0x200(%rbx)`), but the shadowing
declaration's initializer code loads the base from the NEW binding's slot
(`mov 0x150(%rbx),%rax` in the `.Test` arm, slot `0x148` in the `.Proj`
arm) — a slot no code in the function ever stores to before that point.
The non-shadowing `.Ctor` arm (`cargs = t->data.Ctor.args`) loads the
correct slot `0x200`. Three arms, same initializer shape, two different
base slots — the self-referential ones are UB.

## Affected emission sites (`src/codegen/exprs/match.yo`)

1. tagged-union positional destructuring `.Variant(a, b)` → `T a = m->data.V.f;`
2. tagged-union labeled destructuring `.Variant({a : x})`
3. nullable-pointer payload bind `.(p) => ...`
4. `=> rename` whole-match bind `.Variant => name`
5. (defensive) subject materialization `T subject_temp = <matched>;`

## Fix

`_emit_pattern_binding_decl` (match.yo): when the binding's name appears in
the initializer, hoist the initializer into a fresh temp first:

```c
__yo_t0* __yo_pat_init_1 = t->data.Node.t;  // outer t still in scope
__yo_t0* t = __yo_pat_init_1;               // harmless copy
```

The substring test is deliberately conservative (the initializer's only
identifiers are the matched-value code and type tags; a false positive
costs one temp that -O2 folds away).

## Notes

- The Yo-level code (`match` arm binding shadowing a parameter) is legal
  Yo; only the C emission was wrong.
- Yo source cannot express the bug directly (no null for ref enums) — the
  NULL/garbage only exists at the C level, which is why the crash traces
  looked like RC/UAF corruption and defied memory-oriented debugging.
- `:=` rebinding does not have this shape (same-scope C redeclaration
  would be a compile error, so that path never emitted it).
