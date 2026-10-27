#!/bin/bash
# assert-binary-allocator.sh — prove a built yo binary carries the heap it was
# built for: mimalloc linked in, or none of it (the system allocator).
#
#   bash scripts/assert-binary-allocator.sh <binary> <system|mimalloc>
#
# DETECT VIA STRING LITERALS, NOT SYMBOLS. A linked PE carries no COFF symbol
# table (debug info goes to a PDB), so `llvm-nm` on a release .exe reports
# nothing for either allocator. mimalloc's options.c emits the message
# prefixes "mimalloc: error: " and "mimalloc: warning: " unconditionally, and
# they land in .rdata/.rodata in every object format.
#
# Match ONLY those prefixes, never a bare "mimalloc: ": the compiler embeds the
# text of the emitted C's `#error "--allocator mimalloc: mimalloc.h not found
# ..."` (src/codegen/c/collection.yo), so every yo binary carries one bare
# "mimalloc: " whatever heap it links. That false positive failed v0.2.71's
# first release run on both system-allocator Windows legs
# (issues/fixed/2026-10-27-the-windows-release-allocator-assertion-counts-the-compilers-own-mimalloc-diagnostic.md).
#
# release.yml runs this on every Windows seed bundle. test.yml runs it on BOTH
# arms every battery (the memory-ratchet job's mimalloc stage-2 binary and its
# libc-heap rebuild, plus the Windows suite legs' PE), so a change to the
# compiler's strings that breaks the discrimination fails before a release.
set -u
BIN="${1:?usage: assert-binary-allocator.sh <binary> <system|mimalloc>}"
WANT="${2:?usage: assert-binary-allocator.sh <binary> <system|mimalloc>}"
if [ ! -f "$BIN" ]; then
  echo "::error::$BIN does not exist"
  exit 1
fi
HITS=$(grep -a -c -e "mimalloc: error: " -e "mimalloc: warning: " "$BIN" || true)
BYTES=$(wc -c < "$BIN")
echo "requested=$WANT  mimalloc message-literal hits=$HITS  size=$BYTES bytes  ($BIN)"
case "$WANT" in
  mimalloc)
    if [ "$HITS" -gt 0 ]; then
      echo "mimalloc confirmed linked in."
    else
      echo "::error::asked for mimalloc but $BIN carries no mimalloc message literals — static.c is missing from the link line"
      exit 1
    fi
    ;;
  system)
    if [ "$HITS" -eq 0 ]; then
      echo "system allocator confirmed (no mimalloc linked)."
    else
      echo "::error::asked for the system allocator but $BIN carries $HITS mimalloc message literals"
      exit 1
    fi
    ;;
  *)
    echo "::error::unknown allocator '$WANT' (expected system or mimalloc)"
    exit 1
    ;;
esac
