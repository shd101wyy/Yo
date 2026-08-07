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

Conventions:

- File names are kebab-case and say what is broken, not where it was found.
- When fixing an issue, update the doc with the root cause + verification,
  then `git mv` it to `fixed/` in the same commit and update references
  (`grep -rn "issues/<name>.md"`).
- Retire (rather than fix) a doc only when its content is a snapshot that
  events made moot — keep the file, add a line saying what superseded it.
