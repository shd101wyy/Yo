# Should Yo have generators, built on allocation-free async frames?

**Kind:** design question — an open decision, not a defect. Filed 2026-11-28 with the adoption of VERDICTS-96 (§3), from [`plans/backlog/ERRORS_AS_VALUES.md`](../../plans/backlog/ERRORS_AS_VALUES.md). Not to be decided before AFA-7 and E-5, so v0.2.88 at the earliest.

Design: [`plans/backlog/GENERATORS.md`](../../plans/backlog/GENERATORS.md) (VERDICTS-97).

## The question

VERDICTS-95's audit of real effect handlers found one clearly valuable use: generators, a `gen` block that `yield`s and a `for` over it. std hand-writes 84 `next` state machines (34 in the prelude); a generator written today with a task and a capacity-1 channel costs about 580 ns per item against 0.9 ns for a hand-written `Iterator` (VERDICTS-95 §1, probes `g01a`/`g01b`). Rust's `gen` blocks are still unstable.

With `ctl` and `unwind` deleted (VERDICTS-96), should Yo add generators as a feature of their own, lowered to the frames ALLOCATION_FREE_ASYNC builds?

## What it needs and what it does not

- It needs the AFA frame protocol (AFA-3, and AFA-7's deletion of the cell fallback), origins and second-class closures for a borrow across a `yield` (REFERENCES_AND_ORIGINS O5, O10; BORROW_CHECKER_COMPLETENESS P4), and a delimiter expression.
- It needs no handler record, no capability and none of today's `ctl`/`unwind` machinery.
- `yield` is a high-prior idiom for models, and Dafny's `yield ensures` is a known contract form, so a generator can enter the verifier with a contract on day one.
- `plans/archive/CAPABILITIES_AND_HANDLERS.md` §5 (handlers on frames, the typing rules T1–T9) is the design record to start from. A handler that names its continuation is not part of this question: it has the lowest prior, no verification story and no program in the tree that asks for it.

## Entry condition

VERDICTS-95's H-0 restricted to generators: an executable model of the typing rules with a negative corpus, the benchmarks against a hand-written `Iterator`, and an authorship eval (models writing generators against hand-written iterators), plus a contract form for `yield`.

## Recommendation

Do not decide now. Reopen after AFA-7 and E-5 have landed (v0.2.88 or later) and run the entry condition above. Adopt generators if the model is sound, a generator costs no more than its hand-written `Iterator` in time and allocations, and the eval shows models write it more reliably. Until then std keeps hand-written iterators.
