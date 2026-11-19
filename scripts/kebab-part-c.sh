#!/usr/bin/env bash
# kebab-part-c.sh — regenerate kebab-case Part C on the current tree
# (plans/backlog/KEBAB_CASE_NAMES.md Part C; VERDICTS-67).
#
#   scripts/kebab-part-c.sh <yo>     # <yo>: a binary built from THIS tree, which has `fix --module-names`
#
# Run on a clean worktree at the tip the rename lands on. It never commits.
#
#   1. The two `_expr.yo` dispatch modules become `dispatch.yo`: their kebab-case
#      spelling `expr.yo` collides with a sibling module, which the tool refuses.
#   2. `yo fix src std tests scripts build.yo --module-names` renames every
#      module file and directory whose name holds `_` or upper case (test files
#      too: nothing imports them, but `check` would warn on every one) and
#      rewrites the imports, `[modules]` entries and `build.yo` roots that
#      resolve to them. cli-case fixtures and the origins corpus keep their
#      names; their imports are rewritten.
#   2b. `std/fmt/to_string.yo` goes back to its name: the seed's template-literal
#      desugar imports it by that path (the seed hold-back, below).
#   3. A textual sweep applies the printed rename map to what the tool cannot
#      see: comments, string literals holding a path, Markdown outside plans/
#      and issues/, workflows, shell scripts, known-failing.tsv, cli-case
#      `*.fixture` inputs and goldens. plans/ and issues/ keep their text
#      (AGENTS.md "Reading historical documents" translates them).
#
# Afterwards (the PR's procedure, not this script): build the renamed tree,
# `check ./src` and `check ./std`, and run scripts/cli-diff-test.sh with that
# binary; cases whose fixture contents changed move their expected_tree hash and
# are re-recorded after reading each GOLDEN-DIFF.
set -euo pipefail
# The whole script is one compound command, so bash has parsed all of it
# before step 3 runs (the sweep must never see this file, and bash reads a
# script lazily).
{

YO=${1:?usage: scripts/kebab-part-c.sh <yo-binary built from this tree>}
YO=$(cd "$(dirname "$YO")" && pwd)/$(basename "$YO")
cd "$(dirname "$0")/.."
ROOT=$(pwd)

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "kebab-part-c: the worktree has uncommitted changes; run it on a clean tip" >&2
  exit 2
fi
"$YO" fix --help | grep -q -- '--module-names' || {
  echo "kebab-part-c: $YO has no 'fix --module-names'; build this tree first" >&2
  exit 2
}

MAP=${KEBAB_MAP:-$ROOT/tmp/kebab-part-c.map}
mkdir -p "$(dirname "$MAP")"

# ── 1. The collisions, by hand ──────────────────────────────────────────────
: > "$MAP.pre"
for d in src/evaluator/exprs src/codegen/exprs; do
  if [ -f "$d/_expr.yo" ]; then
    [ -e "$d/dispatch.yo" ] && { echo "kebab-part-c: $d/dispatch.yo already exists" >&2; exit 1; }
    git mv "$d/_expr.yo" "$d/dispatch.yo"
    printf 'fix: rename %s -> %s\n' "$d/_expr.yo" "$d/dispatch.yo" >> "$MAP.pre"
  fi
done
# Their importers: `./_expr.yo`, `../exprs/_expr.yo`, `./exprs/_expr.yo`,
# `./evaluator/exprs/_expr.yo`. Only these two modules are named `_expr.yo`.
git grep -l -E '/_expr\.yo"' -- src tests | xargs -r sed -i -E 's#/_expr\.yo"#/dispatch.yo"#g'

# ── 2. The tool ─────────────────────────────────────────────────────────────
"$YO" --std-path ./std fix src std tests scripts build.yo --module-names | tee "$MAP.tool"

# ── 2b. The seed hold-back ──────────────────────────────────────────────────
# `std/fmt/to_string.yo` keeps its name in v0.2.79: the v0.2.78 seed's parser
# desugars every template literal with an injected `import("std/fmt/to_string")`,
# so the seed cannot build a tree without that file. Its contents and its own
# imports are migrated; only the name and the strings naming it go back. This
# tree's parser injects `import("std/fmt")` instead (src/parser.yo
# `get_program`), so v0.2.80, built by the v0.2.79 seed, renames the file with
# `yo fix std src tests --module-names` and no forwarder
# (issues/questions/2026-11-19-std-fmt-to-string-keeps-its-name-for-the-seed.md).
if [ -f std/fmt/to-string.yo ] && [ ! -e std/fmt/to_string.yo ]; then
  mv std/fmt/to-string.yo std/fmt/to_string.yo
  # Plain grep: the renamed files are not in the index yet.
  grep -rlE --include='*.yo' 'fmt/to-string(\.yo)?"|"\./to-string(\.yo)?"' std src tests scripts \
    | xargs -r sed -i -E 's#fmt/to-string(\.yo)?"#fmt/to_string\1"#g; s#"\./to-string(\.yo)?"#"./to_string\1"#g'
fi
grep '^fix: rename ' "$MAP.tool" | grep -v '^fix: rename std/fmt/to_string\.yo ' | cat "$MAP.pre" - > "$MAP"

# ── 3. The textual sweep ────────────────────────────────────────────────────
# Stage the renames first: the sweep walks `git ls-files`.
git add -A src std tests scripts build.yo yo.toml
python3 -I - "$MAP" <<'PY'
import os, re, subprocess, sys

map_path = sys.argv[1]
pairs = []                      # (old, new, is_dir), repo-relative
for line in open(map_path, encoding="utf-8"):
    m = re.match(r"^fix: rename (\S+) -> (\S+)$", line.strip())
    if not m:
        continue
    old, new = m.group(1), m.group(2)
    is_dir = old.endswith("/")
    pairs.append((old.rstrip("/"), new.rstrip("/"), is_dir))

# The tool prints each entry at its OLD location (parents not yet renamed) and
# its NEW location in full, so a child entry's old path already names the old
# parents. Every old path, with and without `.yo`, maps to its new path.
full = {}
for old, new, is_dir in pairs:
    full[old] = new
    if not is_dir and old.endswith(".yo") and not old.endswith(".test.yo"):
        full[old[:-3]] = new[:-3]
# A path below a renamed directory whose own name is fine is covered by the
# directory entry (`tests/import_constants/` → `tests/import-constants/`).

# Shorter citations: a path suffix with at least one `/` (`codegen/exprs/foo_bar.yo`,
# `collections/array_list`), and a bare `foo_bar.yo` basename. A suffix kept
# only when every entry ending in it agrees on the new spelling.
suffix = {}
conflict = set()
for old, new in list(full.items()):
    o_parts, n_parts = old.split("/"), new.split("/")
    for k in range(1, len(o_parts)):
        so, sn = "/".join(o_parts[k:]), "/".join(n_parts[k:])
        if so == sn or so in full:
            continue
        if suffix.get(so, sn) != sn:
            conflict.add(so)
        suffix[so] = sn
for c in conflict:
    suffix.pop(c, None)
base = {so: sn for so, sn in suffix.items() if "/" not in so and so.endswith(".yo")}
partial = {so: sn for so, sn in suffix.items() if "/" in so}

def compile_table(table, allow_slash_before):
    keys = sorted(table, key=len, reverse=True)
    if not keys:
        return None
    before = r"(?<![A-Za-z0-9_.\-])" if allow_slash_before else r"(?<![A-Za-z0-9_.\-/])"
    pat = re.compile(before + "(" + "|".join(re.escape(k) for k in keys) + r")(?![A-Za-z0-9_\-])")
    return pat, table

# A `/` may precede any form: `${HERE}/bench/io_bench.yo`, `./to_string.yo`,
# `cond.yo/match.yo/while_loop.yo`.
FULL = compile_table(full, True)
PARTIAL = compile_table(partial, True)
BASE = compile_table(base, True)

def sweep(text, tables):
    out_lines = []
    for line in text.split("\n"):
        # The AGENTS.md translate-as-you-read line names the old spellings on purpose.
        if "pre-v0.2.79 spelling" in line:
            out_lines.append(line)
            continue
        for t in tables:
            if t is None:
                continue
            pat, table = t
            # A line that already spells the new name next to the old one is a
            # deliberate before/after (`array_list.yo` -> `array-list.yo`).
            line = pat.sub(lambda m, ln=line: m.group(1) if table[m.group(1)] in ln else table[m.group(1)], line)
        out_lines.append(line)
    return "\n".join(out_lines)

files = subprocess.run(["git", "ls-files", "-z"], capture_output=True, check=True).stdout.decode().split("\0")
SKIP_PREFIX = ("plans/", "issues/", "vendor/", "tests/origins/corpus/", "scripts/kebab-part-c.sh")
TEXT_EXT = (".yo", ".md", ".sh", ".env", ".yml", ".yaml", ".tsv", ".toml", ".txt", ".json", ".ps1", ".py",
            ".fixture", ".c", ".h", ".input", ".expected")
changed = 0
for f in files:
    if not f or f.startswith(SKIP_PREFIX) or not os.path.isfile(f):
        continue
    name = os.path.basename(f)
    in_case = f.startswith("tests/cli-cases/")
    in_fixture = in_case and "/fixture/" in f
    is_text = f.endswith(TEXT_EXT) or (in_case and name in ("cmd", "opts", "ignore", "stdin")) or name.startswith("expected_")
    if not is_text:
        continue
    try:
        # newline="": keep CRLF bytes (the LSP cases' stdin and goldens are framed with them).
        text = open(f, encoding="utf-8", newline="").read()
    except UnicodeDecodeError:
        continue
    # A cli case's fixture is its own project, whose file names are not the
    # tree's: only a full repo path (a std import) is swept there. Its other
    # files (cmd, opts, stdin, goldens) take partial paths too, never a bare
    # basename, which may name a fixture file.
    tables = [FULL] if in_fixture else ([FULL, PARTIAL] if in_case else [FULL, PARTIAL, BASE])
    new_text = sweep(text, tables)
    if new_text != text:
        # A framed LSP transcript carries Content-Length headers; a rewrite that
        # changes a body's byte length would break its framing.
        if in_case and "Content-Length:" in text and len(new_text.encode()) != len(text.encode()):
            sys.exit(f"kebab-part-c: {f}: the sweep would change the length of a framed LSP transcript; fix it by hand")
        open(f, "w", encoding="utf-8", newline="").write(new_text)
        changed += 1
print(f"kebab-part-c: textual sweep rewrote {changed} file(s) "
      f"({len(full)} full paths, {len(partial)} partial paths, {len(base)} basenames)")
PY

git add -A src std tests scripts build.yo yo.toml docs .github AGENTS.md README.md pack vscode-extension
echo "kebab-part-c: done; map in $MAP. Next: build, check ./src and ./std, cli-diff (see the header)."
exit 0
}
