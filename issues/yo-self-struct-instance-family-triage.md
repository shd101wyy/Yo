# struct-instance-identity family — triage (2026-07-25)

The handoff's three-family table groups `cli/arg_parser` and "the imm family"
under one **struct-instance identity** heading. Measured against a HEAD-behaviour
s1, that grouping is **wrong**: those files fail for at least three unrelated
reasons, and only one of them is a struct-instance problem. Anyone picking this
family up should treat them separately.

## Current red list, re-split by measured signature

From `/tmp/sweep69_ext/results.txt` (164/183). Six of the nineteen reds are
STALLs, which the family table does not mention at all:

| class                 | files                                                                                                                 | evidence                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| STALL (rc=137, 420 s) | `collections/btree_map`, `collections/priority_queue`, `imm_sorted_map`, `imm_sorted_set`, `imm_threading`, `imm_vec` | all killed at the sweep timeout, not a C error |
| comptime param model  | `imm_map`, `imm_set`                                                                                                  | hollow markers, see below                      |
| struct-instance       | `cli/arg_parser`                                                                                                      | clean emit, see below                          |
| other                 | `collections/ordered_map`                                                                                             | third signature, see below                     |

## `imm_map` / `imm_set` — NOT struct-instance. Comptime param model.

Both emit `use of undeclared identifier 'result'` ×10, which is a **cascade, not
the bug**. `result` IS declared; its initializer is malformed:

```c
__yo_t95 _file____User_temp_9109 = yo_id_5427(
    (// Unknown type: Type)(/* Error: no C type name for i32 */),
    (// Unknown type: Type)(/* Error: no C type name for i32 */), …);
```

A comment emitted where an expression belongs. The declaration therefore fails
to parse and every later `result` reference reports "undeclared".

Marker counts in the yo-self emit (`imm_map`): `Unknown type: Type` = 8,
`no C type name` = 8, `Failed to transpile` = 2. TS passes the same file 21/21.

This is the already-documented **comptime-Type-arg-as-runtime-param** root
(`issues/yo-self-gap6-ctor-memo-reconciliation-attempt7.md`, "Round-2
correction" section; handoff task #15, WIP patch at
`scratchpad/round2_param_model_wip.patch`). Do not chase it as a type-identity
bug.

NOTE the hollow-green hazard here: because these files already emit
`Unknown type: Type` / `Failed to transpile` markers, any change that makes them
compile MUST be checked for marker count against the TS emit before it is called
a flip.

## `cli/arg_parser` — the genuine struct-instance case, and it is NOT a duplicate type

Clean emit: `Unknown type: Type` = 0, `no C type name` = 0,
`Failed to transpile` = 0. Nine errors, all one shape:

```
initializing '__yo_t35' with an expression of incompatible type '__yo_t24'
passing     '__yo_t35' to parameter of incompatible type '__yo_t24'
```

The two types are structurally identical — both an `Option`-shaped enum whose
`Some` payload is a single `__yo_t23*` — but carry different nominal ids
(`enum_yo_id_2438` vs `enum_yo_id_4936`).

**The obvious reading is wrong.** "yo-self mints a duplicate `Option`" does not
survive measurement: emitting the same test through BOTH compilers gives an
identical type universe —

```
TS   enum typedefs: 14   Some-payload enums: 9
s1   enum typedefs: 14   Some-payload enums: 9
```

So yo-self is not creating an extra type. The defect is that it selects the
WRONG ONE of two legitimately distinct types at specific call sites.

Pinned precisely. `yo_id_4986` is declared once, returning `__yo_t24`, and is
called four times on the same argument:

| line | declared temp | correct |
| ---- | ------------- | ------- |
| 6484 | `__yo_t24`    | yes     |
| 7569 | `__yo_t35`    | no      |
| 8501 | `__yo_t35`    | no      |
| 9625 | `__yo_t35`    | no      |

The callee's return type is right everywhere; three of four CALL SITES record
the wrong result type for it. So this is not about how the type was created —
it is about the type recorded for a call EXPRESSION at a particular site.

Leading hypothesis, NOT yet tested: the call's result type is being overwritten
by the site's EXPECTED type instead of keeping the callee's declared return.
`function.yo` has machinery that deliberately does this kind of adoption for
`Self` returns (`adopt_receiver_struct_instance`, ~:1520-1560, which swaps a
pattern-era instance for the receiver's concrete one). If that fires where the
declared return is already concrete, it would produce exactly this. VERIFY
BEFORE FIXING — the previous family burned four cycles on fixes built atop an
unverified premise.

Cheapest next step: the divergence is reproducible in 3 s and the emit is clean,
so diff the yo-self and TS C around those four call sites (`/tmp/argp_s1.c` vs
`/tmp/argp_ts.c` regenerate via `YO_KEEP_BATCH=1 … test ./tests/cli/arg_parser.test.yo`)
and identify what differs about site 6484, the one that gets it right.

## `collections/ordered_map` — a third signature

`initializing '__yo_t34' with an expression of incompatible type 'int'` ×14,
plus a call to an undeclared `yo_id_5272_rtparam0_…` spec. Neither the imm
hollow-marker shape nor the arg_parser one. Not triaged further.

## Method note

Everything above was measured, not inferred. The two readings that looked
obvious from the error text alone — "`result` is an undeclared-variable bug" and
"arg_parser mints a duplicate `Option`" — were both false, and both took one
cheap command to disprove (read the initializer; count enum typedefs in both
emits). Do that before opening the evaluator.
