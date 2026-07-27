#!/bin/bash
# Capture-split fix gate chain, part B — battery + corpus (needs ./tests free).
# Run only after the g14 sweep completes. S1 = /tmp/cf2_s1.
set -u
cd /Users/yiyiwang/Workspace/Yo || exit 2
S1=/tmp/cf2_s1

echo "=== GATE 1: test battery ==="
for t in tests/arc.test.yo tests/prelude.test.yo tests/thread.test.yo tests/worker.test.yo tests/async_await.test.yo tests/sys/bufio.test.yo tests/fs/file.test.yo tests/fs/temp.test.yo tests/fs/walker.test.yo tests/sys/signal.test.yo tests/cycle_collector.test.yo tests/basic.test.yo tests/closure.test.yo tests/imm_list.test.yo tests/imm_string.test.yo tests/module_struct_unification.test.yo tests/ref_struct.test.yo tests/fn.test.yo tests/iso.test.yo tests/rc.test.yo; do
  name=$(basename "$t" .test.yo)
  timeout 1200 "$S1" test "$t" &> "/tmp/cf2_${name}.log"
  rc=$?
  if [ $rc -ne 0 ] && [ ! -s "/tmp/cf2_${name}.log" ]; then
    timeout 1200 "$S1" test "$t" &> "/tmp/cf2_${name}.log"  # phantom-kill retry
    rc=$?
  fi
  tail -4 "/tmp/cf2_${name}.log" | tr '\n' ' '
  echo "  <- $name rc=$rc"
done

echo "=== GATE 2: corpus diff-test ==="
YO_SELF_BIN=$S1 scripts/diff-test.sh tests/codegen-bootstrap --release --parallel 4 &> /tmp/cf2_corpus.log
tail -3 /tmp/cf2_corpus.log
echo "=== part B done ==="
