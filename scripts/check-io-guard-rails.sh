#!/usr/bin/env bash
# The Io interface's guard rails in std (plans/backlog/ALLOCATION_FREE_ASYNC.md
# §4, plans/backlog/IO_INTERFACE_AND_STD_RUNTIME.md §3). The allocation-free
# async plan later starts every operation in a slot its caller owns (AFA-8),
# which rewrites `std/sys` and the two files named below; these rails keep
# every other std file out of that rewrite. A grep gate, no binary needed.
#
#   1. `io.vtable.*.<op>(...)` is called only in `std/sys/`.
#   2. `IoFuture` is named, outside comments, only in the prelude (which
#      declares it and the `IoVTable`), in `std/sys/`, and in the two files
#      that build join waits and parks today: `std/async/index.yo` and
#      `std/async/waker.yo`.
#   3. Above `std/sys` (those two files aside), an operation is awaited where
#      it is made: every call of a `std/sys` operation (a function whose
#      result is `IoFuture`) is the direct operand of an `.await(`. std
#      reaches the operations through a module alias (`IO_file ::
#      import("../sys/file")`), so a destructured import of one is rejected
#      too: the call could not be told from any other.
#
# Usage (from anywhere in the repository): bash scripts/check-io-guard-rails.sh

set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 2

EXEMPT_RE='^std/(sys/|prelude\.yo:|async/index\.yo:|async/waker\.yo:)'
fail=0

# Strip `//` comments (line and doc comments) before matching. The patterns
# below never contain `//`.
code_lines() {
  # $1: a grep -E pattern; prints file:line:code for std/**.yo outside comments.
  git grep -nE "$1" -- 'std/*.yo' 'std/**/*.yo' | sed -E 's|^([^:]*:[^:]*:)(.*)$|\1\2|; s|//.*||' | grep -E "^[^:]*:[^:]*:.*($1)" || true
}

# 1. Calls through an Io's table: `vtable.*.<label>(` for a label of the
# prelude's `IoVTable` (an `Allocator`'s table has other labels).
io_labels=$(awk '/^IoVTable :: struct\(/ { on = 1; next } on && /^\);/ { exit } on && /^  [a-z_]+ : \(fn/ { sub(/^  /, ""); sub(/ :.*/, ""); print }' std/prelude.yo | paste -sd '|')
if [ -z "$io_labels" ]; then
  echo "::error::found no IoVTable field in std/prelude.yo; the gate is broken"
  exit 1
fi
hits=$(code_lines "vtable\.\*\.($io_labels)\(" | grep -vE '^std/sys/' || true)
if [ -n "$hits" ]; then
  echo "::error::io.vtable.*.<op> outside std/sys (ALLOCATION_FREE_ASYNC.md §4, rail 1):"
  echo "$hits"
  fail=1
fi

# 2. IoFuture outside its four homes.
hits=$(code_lines '\bIoFuture\b' | grep -vE "$EXEMPT_RE" || true)
if [ -n "$hits" ]; then
  echo "::error::IoFuture named outside std/sys, the prelude, std/async/index.yo and std/async/waker.yo (rail 1):"
  echo "$hits"
  fail=1
fi

# 3. Operations awaited where they are made.
# The operations: every std/sys function whose signature ends in `-> IoFuture`
# (a signature may span lines, so the name is the last `name :: (` seen).
mapfile -t op_rows < <(
  for f in std/sys/*.yo; do
    awk -v mod="$(basename "$f" .yo)" '
      /^[A-Za-z_][A-Za-z0-9_]* :: \(/ { name = $1 }
      /-> IoFuture\)/ { if (name != "") { print mod " " name; name = "" } }
    ' "$f"
  done | sort -u
)
if [ "${#op_rows[@]}" -eq 0 ]; then
  echo "::error::found no std/sys operation (a function returning IoFuture); the gate is broken"
  exit 1
fi
declare -A ops_of
for row in "${op_rows[@]}"; do
  mod=${row%% *}
  op=${row#* }
  ops_of[$mod]="${ops_of[$mod]:+${ops_of[$mod]}|}$op"
done
for f in $(git ls-files 'std/*.yo' 'std/**/*.yo' | grep -vE '^std/(sys/|prelude\.yo$|async/index\.yo$|async/waker\.yo$)'); do
  # Every import of a std/sys module that has operations: aliased, or
  # destructuring no operation.
  while IFS= read -r imp; do
    [ -z "$imp" ] && continue
    mod=$(sed -E 's/.*import\("[./]*sys\/([a-z_]+)(\.yo)?"\).*/\1/' <<<"$imp")
    ops=${ops_of[$mod]:-}
    [ -z "$ops" ] && continue
    code=${imp#*:}
    if [[ "$code" =~ ^[[:space:]]*\{ ]]; then
      if grep -qE "[{,][[:space:]]*($ops)[[:space:]]*[,}]" <<<"$code"; then
        echo "::error::$f:$imp destructures a std/sys operation; import the module as an alias (rail 2)"
        fail=1
      fi
    elif [[ "$code" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*:: ]]; then
      alias=${BASH_REMATCH[1]}
      # Each call `alias.op(` must follow `.await(` directly.
      while IFS= read -r call; do
        [ -z "$call" ] && continue
        echo "::error::$f:$call: a std/sys operation not awaited where it is made (rail 2)"
        fail=1
      done < <(grep -nE "\b$alias\.($ops)\(" "$f" | sed -E 's|//.*||' | grep -E "\b$alias\.($ops)\(" | grep -vE "\.await\($alias\.($ops)\(" || true)
    fi
  done < <(grep -nE 'import\("[./]*sys/[a-z_]+(\.yo)?"\)' "$f" || true)
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "io guard rails: OK (${#op_rows[@]} std/sys operations)"
