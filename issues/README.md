# issues/ — bug and issue records

One markdown file per issue: the symptom (verbatim errors), a minimal
reproducer, root-cause analysis, and — once resolved — the fix and its
verification. See the "Debugging codegen / C compilation issues" workflow in
`AGENTS.md`.

## Layout

| Location   | Meaning                                                                                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./*.md`   | **Open** issues — file new issues here                                                                                                                                             |
| `fixed/`   | **Verified fixed** — the fix landed with a regression test; move the doc here in the fixing commit                                                                                 |
| `retired/` | **Superseded / no longer applicable** — dated triage snapshots and issue records whose subject was resolved wholesale (e.g. by a completed campaign) rather than by a targeted fix |
| `repros/`  | Standalone `.yo` reproducer files referenced by issue docs                                                                                                                         |
| `patches/` | WIP / reference patches referenced by issue docs                                                                                                                                   |

`TRIAGE.md` is a generated, categorised index of everything currently in the
root — areas, self-reported status, and which docs have a runnable reproducer.
It is a navigation aid; each doc stays authoritative about itself. Regenerate it
rather than hand-editing, and note its three caveats: a doc's own `Status:`
header is a claim rather than a verdict, a repro exiting 0 has not necessarily
passed (most print evidence and exit 0 either way), and an expected-value table
inside a doc is a claim too — two were found wrong on 2026-09-14.

`scripts/check-issue-refs.sh` is the standing guard. It asserts two things: no
doc exists in more than one of root/`fixed/`/`retired/`, and every cited
`issues/**` path resolves. It REPORTS rather than repairs, because a
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
- When fixing an issue, update the doc with the root cause + verification,
  then `git mv` it to `fixed/` in the same commit and update references
  (`grep -rn "issues/<name>.md"`).
- Retire (rather than fix) a doc only when its content is a snapshot that
  events made moot — keep the file, add a line saying what superseded it.
