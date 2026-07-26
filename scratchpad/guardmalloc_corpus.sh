#!/usr/bin/env bash
# Memory-safety gate for RC dup/drop-elision work, since AddressSanitizer is
# UNUSABLE on this box (yo-cli detects the broken runtime and silently skips
# instrumentation, so `--sanitize address` is a vacuous pass).
#
# Guard Malloc (/usr/lib/libgmalloc.dylib) is the working substitute: every
# allocation gets its own page, unmapped on free. Verified to actually FAIL on
# both failure modes an RC over-drop produces:
#     use-after-free read -> SIGSEGV (rc=139)
#     double free         -> SIGABRT (rc=134)
# (Plain MallocScribble does NOT work on this macOS allocator — a UAF read
# still returned live data — so do not rely on it.)
#
# Needs --allocator libc so Yo's frees go through malloc/free.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 2

DIR="${1:-tests/codegen-bootstrap}"
OUT="${OUT:-/tmp/gm_corpus}"
mkdir -p "$OUT"
: >"$OUT/results.txt"

ok=0; bad=0; skip=0
for f in "$DIR"/*.yo; do
  b=$(basename "$f" .yo)
  case "$b" in *.test) continue;; esac
  log="$OUT/$b.log"
  if ! ./yo-cli compile "$f" --release --allocator libc \
       -o "$OUT/$b.bin" >"$log" 2>&1; then
    echo "COMPILE-FAIL $b" >>"$OUT/results.txt"; skip=$((skip+1)); continue
  fi
  # Baseline run (no guard malloc) to learn this program's own exit code —
  # several corpus programs exit non-zero by design.
  "$OUT/$b.bin" >"$OUT/$b.base.out" 2>/dev/null; base_rc=$?
  DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib MALLOC_PROTECT_BEFORE=1 \
    "$OUT/$b.bin" >"$OUT/$b.gm.out" 2>>"$log"; gm_rc=$?

  if [ "$gm_rc" != "$base_rc" ]; then
    echo "GM-FAIL $b base_rc=$base_rc gm_rc=$gm_rc" >>"$OUT/results.txt"; bad=$((bad+1))
  elif ! cmp -s "$OUT/$b.base.out" "$OUT/$b.gm.out"; then
    echo "GM-OUTPUT-DIFF $b" >>"$OUT/results.txt"; bad=$((bad+1))
  else
    echo "OK $b" >>"$OUT/results.txt"; ok=$((ok+1))
  fi
  rm -f "$OUT/$b.bin"
done
echo "GM_CORPUS_DONE ok=$ok bad=$bad compile_skip=$skip"
grep -vE "^OK " "$OUT/results.txt" | head -30
