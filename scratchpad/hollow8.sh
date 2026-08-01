#!/bin/bash
# hollow8.sh — measure the 8 remaining hollow files + the RED + the two era canaries.
#   BIN=/tmp/shNNN TAG=t bash scratchpad/hollow8.sh
set -u
cd /Users/yiyiwang/Workspace/Yo || exit 2
BIN="${BIN:-/tmp/s1fam2}"
TAG="${TAG:-h8}"
for t in tests/async_await.test.yo tests/basic.test.yo tests/fn.test.yo \
         tests/higher_kinded_types.test.yo tests/imm_map.test.yo \
         tests/iter_filter_closure.test.yo tests/iterator_combinators.test.yo \
         tests/prelude.test.yo tests/where_clause_fn_inference.test.yo \
         tests/array.test.yo tests/for_macro_borrow.test.yo; do
  BIN="$BIN" T="$t" TAG="$TAG" TIMEOUT_S="${TIMEOUT_S:-900}" bash scratchpad/measure_one.sh
done
