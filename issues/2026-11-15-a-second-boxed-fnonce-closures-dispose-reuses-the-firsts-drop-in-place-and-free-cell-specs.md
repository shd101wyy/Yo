# A second boxed FnOnce closure's dispose reuses the first's `drop_in_place` and `_free_cell` specs

**Severity:** S1 (a flip regression: the legacy `dyn(closure)` alias spelling compiles clean on the
seed v0.2.77, while two `dyn(Box.new(closure))` of one `Dyn(FnOnce(...))` in one program emit C that
does not compile — `tests/fn_once.test.yo`'s whole batch, 40/40 rows reported failed)

## Symptom

Two closures with DIFFERENT captures, both boxed into `Box(Dyn(FnOnce(go : bool) -> i32))`, whose
bodies move the capture into a `sink` parameter (`_once_take(sink(t) : _OnceTok)`):

```yo
u := _OnceTok(n : i32(6));
(d : Box(Dyn(FnOnce(go : bool) -> i32))) = dyn(Box.new({ u }(go : bool) => _once_take(u)));
w := _OnceTok(n : i32(7));
(e : Box(Dyn(FnOnce(go : bool) -> i32))) = dyn(Box.new({ w }(go : bool) => _once_take(w)));
```

The C compile fails:

```text
error: incompatible pointer types passing '__yo_t_5873941637489959960 *' to parameter of type
'__yo_t_17256977015172363243 *'
```

## Root cause (localized, fix owed)

The dispose specialization for the SECOND box (`Box(<closure-1258>)`'s drop spec, trial id 4531 —
its `_word`, `_payload` and `_is_placed` calls correctly instantiate
`..._4531_capbind_capture_1258...`) resolves its two FREE-FUNCTION-ish inner calls —
`drop_in_place(cell)` and `Self._free_cell(cell, Self._is_placed(self))`, both taking the LOCAL
`cell : *T` as first argument — to the FIRST closure's specs (`..._4536_capbind_capture_5504...`).
No `4531_capbind_capture_1258` variant of `_free_cell` is instantiated at all; the emitted dispose
casts `cell` (of the second capture's struct type) to the first's struct in the `drop_in_place` call
and passes it uncast to the first's `_free_cell`. Same-expression `Self._is_placed(self)` — whose
first argument is `self`, not `cell` — resolves correctly, so the wrong reuse is specific to the
calls whose FIRST RUNTIME ARGUMENT is the body-local `cell`: their spec selection reads a type for
`cell` that belongs to the first trial (4536, the first box's drop), while the emitter lowers the
local with the second trial's type. The spec cache / call resolution reused across the two trials of
the SHARED prelude `drop` body is the suspect (`_find_specialization_cache` /
`check_if_function_parameter_matches_argument` / the trial machinery in
`src/evaluator/calls/function.yo` + `helper.yo`).

The trigger needs (measured, `tmp/p/p17*.yo`): two boxed closures of ONE Dyn fn-trait type with
different captures, and a closure body that moves the capture into a `sink` parameter. Two closures
without the sink call compile clean, as does ONE closure with it.

## Control

- The seed v0.2.77 compiles the legacy alias spelling of the same shape clean
  (`/tmp/p18.yo`: two `dyn(_(u : u)(go : bool) => _once_take(u))` of one `Dyn(FnOnce(go : bool) -> i32)`,
  `clang -Werror=incompatible-pointer-types` clean) — the L2 box dispose path is new, so this is a
  flip regression, not a pre-existing gap.
- Reproducer: `tmp/p/p17a.yo` in this worktree (a one-line change from the passing
  `tmp/p/p17.yo`: `_once_take`'s parameter made a `sink`). yo-il fails its C; the seed passes the
  alias form.

## Fix status

OPEN. The failing-then-passing test is `tests/fn_once.test.yo` rows "a one-argument call of an
FnOnce local is either operand of ==" and the other rows that box two FnOnce closures of one
signature (the batch fails as a unit).
