# Should `box`/`rc`/`arc` become `Box.new`/`Rc.new`/`Arc.new`, as in Rust?

**Kind:** design question. **Decided 2026-10-23 (maintainer): keep `box()`, `rc()` and `arc()` for now.**

## The question

The maintainer asked whether Yo should remove the prelude functions `box(value)`, `rc(value)` and `arc(value)`
(`std/prelude.yo`, about lines 9966, 9763 and 10108; each takes an optional `alloc :`) and construct the three
handles the way Rust does, with `Box.new`, `Rc.new` and `Arc.new`.

## What holds today

An independent review read develop `617cfc052` and probed with the v0.2.68 seed.

- **Call sites:** about 2,038 lines call `box(`, `rc(` or `arc(` (src 1,045, std 27, tests 966). The docs in both
  languages add 165 lines, and the skills and instructions 21 more. Only 11 sites pass `alloc :`, and none uses
  `rc` as a function value.
- **The compiler matches the names in three places:** `src/types/guards.yo:367` (`SharedCellNames("Rc", "rc")`),
  `src/evaluator/values/dyn.yo:1148` and `:1235` (`dyn(...)` synthesizes a call to `"rc"`/`"arc"` by name), and
  `src/evaluator/effects/mutation_summary.yo:3507`. Repointing them is cheap.
- **Inference is the obstacle.** A method called through an unapplied type constructor infers the type's arguments
  only from its receiver (decision 32), so `Pair.mk(i32(2))` on a generic struct is E0613. Bare `ArrayList.new()`
  fails the same way. In Yo today, Rust's `Rc::new(x)` would be spelled `Rc(T).new(x)`, with the payload type
  written at every site. The plan's V4 relies on `rc(...)` inferring `T` at about 1,300 tree-node constructions,
  such as `Rc(ArrayList(HashMap(String, TypeValue)))` (`plans/VALUES_BY_DEFAULT.md`, "Constructors").
- **For the change:**
  - It would make construction uniform: every other type is built as `T(args).new(...)`.
  - Models trained on Rust reach for `Rc::new`.
  - Three lowercase prelude names are a shadowing hazard (`issues/questions/builtin-name-shadows-user-definition.md`;
    3 corpus sites bind `rc` as a local name, defended by `tests/rc_binding_gives_way.test.yo`).
- **Against it:**
  - It needs a new rule, inference from a parameter's declared type. Nested binder inference has been fragile
    before (four fixed issues).
  - That rule would collide with decision 32 on exactly these calls: `Rc.new(some_rc)` would bind `T` from the
    receiver and then mismatch.
  - A 2,000-site sweep in the middle of VBD would collide with B4's src hand edits and with V5's `__yo_cell`
    rewrite of the same lines.

## Recommendation

Keep `box()`, `rc()` and `arc()`. That is the maintainer's decision of 2026-10-23, "keep for now". Revisit only
when both of these hold:

1. A general static-argument inference rule has landed as its own decision: an unapplied type constructor's
   arguments are inferred from any argument whose declared parameter type mentions them, ordered before
   decision 32's receiver rule. That rule does not make a zero-argument `ArrayList.new()` work: inferring from
   the expected type is a separate, larger decision.
2. The rename rides V5 Generation B (v0.2.74 in `plans/handover/VBD_RELEASE_SCHEDULE.md`), when the wrappers'
   internals move onto `__yo_cell` anyway. The plan for it:
   - one `yo fix` migration from `box(` to `Box.new(`, with `alloc :` kept as a named parameter;
   - the old names become an error with a hint, and no aliases;
   - the three compiler name sites are repointed;
   - the docs and skills that say "`new` means an empty collection" are reworded, because `ArrayList(T).new()`
     ensures `len() == 0`.

Measure before reopening:

- how long the payload types get when spelled out at the V4 sites if the inference rule slips;
- an LLM authoring probe: does a model write `rc(x)`, `Rc.new(x)` or `Rc::new(x)` unprompted?
- what the inference rule costs `check ./src`.
