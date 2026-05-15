#!/bin/bash
# Run yo-self-bin fmt on every .yo file, count fail/success.
BIN=/tmp/yo-self-fmt-bin
OK=0; FAIL=0; FAILS=()

while IFS= read -r f; do
  # Copy to a temp so original isn't modified.
  tmp="/tmp/yo_parse_probe_$$.yo"
  cp "$f" "$tmp"
  if "$BIN" fmt --check "$tmp" >/dev/null 2>&1 ; then
    OK=$((OK+1))
  else
    # --check may exit 1 for "would format" — that's OK. Check stderr.
    out=$("$BIN" fmt --check "$tmp" 2>&1)
    rc=$?
    if [ "$rc" = "0" ] || [ "$rc" = "1" ]; then
      OK=$((OK+1))
    else
      FAIL=$((FAIL+1))
      FAILS+=("$f: $out")
    fi
  fi
  rm -f "$tmp"
done < <(find tests yo-self -name "*.yo" 2>/dev/null)

echo "OK: $OK   FAIL: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo
  echo "Failures (first 10):"
  for f in "${FAILS[@]:0:10}"; do
    echo "  - $f"
  done
fi
