#!/bin/bash
# fam.sh — measure the Option/Result-combinator family + the two era canaries.
#   BIN=/tmp/sh108 TAG=f108 bash scratchpad/fam.sh
set -u
cd /Users/yiyiwang/Workspace/Yo || exit 2
BIN="${BIN:-/tmp/sh108}"
TAG="${TAG:-fam}"
for t in tests/option_result_combinators.test.yo tests/prelude.test.yo \
         tests/iter_filter_closure.test.yo tests/iterator_combinators.test.yo \
         tests/imm_map.test.yo tests/higher_kinded_types.test.yo \
         tests/where_clause_fn_inference.test.yo \
         tests/array.test.yo tests/for_macro_borrow.test.yo; do
  BIN="$BIN" T="$t" TAG="$TAG" TIMEOUT_S="${TIMEOUT_S:-900}" bash scratchpad/measure_one.sh
done
