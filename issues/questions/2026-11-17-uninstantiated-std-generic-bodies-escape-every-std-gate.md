# Uninstantiated std generic bodies escape every std gate: how should a rule change reach them?

**Kind:** design question — an open decision, not a defect. Filed 2026-11-17 from the deref-flip fix-forward (`issues/fixed/2026-11-17-std-generic-bodies-the-deref-flip-never-instantiated-keep-the-old-spelling.md`).

## The question

`yo check ./std` type-checks a generic body only at an instantiation. A std generic that nothing in `std/` calls is checked by nothing until a user, or a test file, calls it. Every rule that tightens what a body may say has the same blind spot. The deref flip (#1976) changed the reading rule for std, and its migration and its `check ./std` gate both passed while about twenty std generics still used the old spelling. The first callers were the language test files, and develop went red in eight of them (#1977 and its follow-up).

No gate today walks std's exported generics at a probe type. The language suite covers only the generics some test happens to call, and a bit-battery method with no test is checked by nobody.

## Options

- **A probe test file per std family.** Add a `tests/std_generic_probe.test.yo` that calls every exported generic method at a representative set of types: the integer batteries at all ten widths, the collections at a move-only and a `Clone` payload, and the refine and numeric gates. It is cheap and needs no compiler work. It is a list that someone must keep complete, and a new export is not covered until somebody adds it.
- **A `check` mode that instantiates generics at a probe.** `yo check --probe-generics ./std` would instantiate each exported generic whose bounds a known type satisfies (`i32`, `u8` and `usize` for `Integer`; a `String` payload; a move-only struct) and report body errors there. It is complete by construction for every bound that has a known witness. It costs compiler work: picking a witness per bound, plus a fallback report for bounds with none.
- **The contract model.** `issues/questions/2026-11-04-should-a-generic-body-be-checked-against-its-where-bounds.md` would check a body once against its bounds, with no instantiation needed. It is the complete answer, and also the largest change.

## Recommendation

Do the probe check mode, and land a hand-written probe test now as its seed.

1. **Now.** Add the probe test file for the integer batteries, the refine and numeric gates and the collection methods. These are the families this incident hit. Add it to Tier 1's selection whenever a change touches std's reading or typing rules.
2. **Next.** Add `yo check --probe-generics`, run it in the `check ./std` CI step, and retire the hand list once it covers the same functions.
3. The contract model stays the long-term answer in its own question. The probe mode remains useful under it for comptime-reflective generics, which the contract model exempts.
