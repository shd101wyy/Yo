# issues/ — bug and issue records

One markdown file per issue: the symptom (verbatim errors), a minimal
reproducer, root-cause analysis, and — once resolved — the fix and its
verification. See the "Debugging codegen / C compilation issues" workflow in
`AGENTS.md`.

## Layout

| Location     | Meaning                                                                                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./*.md`     | **Open** issues — file new issues here, each with a `**Severity:**` line (see below)                                                                                               |
| `questions/` | **Design questions** — open design/API/policy decisions rather than defects; each doc carries a `**Kind:** design question` line and a `## Recommendation` awaiting the maintainer's verdict |
| `fixed/`     | **Verified fixed** — the fix landed with a regression test; move the doc here in the fixing commit                                                                                 |
| `retired/`   | **Superseded / no longer applicable** — dated triage snapshots and issue records whose subject was resolved wholesale (e.g. by a completed campaign) rather than by a targeted fix |
| `repros/`    | Standalone `.yo` reproducer files referenced by issue docs                                                                                                                         |
| `patches/`   | WIP / reference patches referenced by issue docs                                                                                                                                   |

## Severity

Every open bug doc carries a one-line verdict directly under its title:

```markdown
**Severity:** S2 — one sentence: the concrete user-visible consequence
```

- **S1 — trust of output.** Miscompilation or silently wrong results; memory
  unsafety in generated code (UAF, double free, uninitialized reads, unbounded
  leaks); a compiler ICE on valid input; bootstrap/self-compile breakage; hangs
  and deadlocks in shipped runtime paths; data corruption.
- **S2 — functional defect, bounded.** Valid programs wrongly rejected or
  invalid ones wrongly accepted with bounded blast radius; std APIs returning
  wrong values; wrong runtime behavior with a workaround; broken CLI/feature
  behavior on reasonable input; async divergence from documented semantics.
- **S3 — quality / rough edge.** Misleading or missing diagnostics;
  documentation and doc-tool defects; fmt cosmetics; missing regression tests;
  CI plumbing and goldens; performance observations; platform gaps with
  workarounds; internal cleanliness.

Assign the line when FILING — a doc that cannot be sorted against the pile
forces every reader to re-derive the answer from prose. The verdicts currently
in the tree were assigned in the 2026-09-28 triage pass over all then-open
docs; like `Status:`, a Severity line is a claim by its last triager — if you
disagree, edit it and say why. A doc whose core is an open decision rather
than a defect ("what should the semantics be", "should this capability exist",
"which default is right") is not a bug: file it under `questions/` instead,
with no Severity line. `scripts/check-issue-refs.sh` fails on a root doc with
no Severity, on a `questions/` doc with no `## Recommendation`, and on a
`questions/` doc that carries a Severity.

`TRIAGE.md` is a generated, categorised index of everything currently in the
root — areas, severity, self-reported status, and which docs have a runnable
reproducer, plus a section for the `questions/` docs. It is a navigation aid;
each doc stays authoritative about itself. Regenerate it
rather than hand-editing, and note its three caveats: a doc's own `Status:`
header is a claim rather than a verdict, a repro exiting 0 has not necessarily
passed (most print evidence and exit 0 either way), and an expected-value table
inside a doc is a claim too — two were found wrong on 2026-09-14.

`scripts/check-issue-refs.sh` is the standing guard. It asserts three things: no
doc exists in more than one of root/`fixed/`/`retired/`/`questions/`, every
cited `issues/**` path resolves, and the triage lines above exist (Severity in
root, Recommendation in `questions/`). It REPORTS rather than repairs, because a
non-resolving reference has three causes and only one is a defect — it may be
stale, it may be *ahead of your tree* (naming where a doc is about to be, per a
branch you do not have), or it may not be a citation at all (prose describing a
before-state, or a quoted `git mv`). Run it on the MERGE RESULT, not on a branch
in isolation, or a concurrent move reads as a stale reference and "repairing" it
reverts someone's work.

**Run it after every MERGE RESOLUTION, not only after edits.** A bulk
`git checkout --theirs` is a scripted edit with the same blast radius as a
tree-wide `sed`: on 2026-09-14 one taken over a list of conflicting cli-case
goldens also reverted a reference repair in a `plans/` doc that was not on
anyone's mind, and the only reason it surfaced was the checker returning 86
instead of 85. That generalises past this directory — **any operation that
touches files you did not enumerate needs a post-condition check**, because the
thing you will miss is by definition the file you were not looking at. An
invariant that returns a number cannot be argued with; "I reviewed the diff"
can.

Conventions:

- File names are kebab-case and say what is broken, not where it was found.
- Assign a `**Severity:**` line when filing (root bugs); a design decision —
  not broken code — goes to `questions/` with a `## Recommendation` stating a
  position the maintainer can accept or overrule.
- When fixing an issue, update the doc with the root cause + verification,
  then `git mv` it to `fixed/` in the same commit and update references
  (`grep -rn "issues/<name>.md"`).
- Retire (rather than fix) a doc only when its content is a snapshot that
  events made moot — keep the file, add a line saying what superseded it.
