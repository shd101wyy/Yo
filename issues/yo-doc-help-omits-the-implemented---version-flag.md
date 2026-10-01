# `yo doc --help` omits the implemented `--version` flag

**Severity:** S3 — help-text untruth on an agent-facing surface; the flag
exists and works, the help does not list it.

**Status: OPEN.** Found 2026-10-01, agent-loop audit CLI pass (yo 0.2.47).
`.github/instructions/documentation.instructions.md` documents
`yo doc --version v1.0.0`, the flag parses (`yo doc --version` →
`yo: error: doc: --version requires a value`), and `--help` lists
`--logo`/`--favicon` but not `--version`.

## Symptom

```
$ yo doc --help
  --logo <path>             Image shown in the sidebar header
  --favicon <path>          Site icon
  (no --version line)

$ yo doc --version v1.0.0   # works
```

## Root cause (narrowed, not fixed)

The flag was added to the option loop in `src/doc_command.yo`/`src/main.yo`
without its `--help` entry; the `help-doc` cli-case golden pins the
helpless text, so the omission is invisible to CI.

## Fix direction

Add the `--version <v> — release version (auto-detects from git if
omitted)` line to the help text (both languages via `tr(...)`) and re-record
the `help-doc` golden. Per the help-truth plan
(`plans/backlog/LLM_AUTHORING_AUDIT_2026-09-19.md` §3.5) the goldens exist
to catch exactly this drift — the review step missed it because the golden
was recorded after the flag landed without its entry.
