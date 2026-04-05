# Variadic Comptime Function Caching Bug (FIXED)

## Problem

When a variadic comptime function is called multiple times with different numbers of arguments, subsequent calls with fewer arguments returned incorrect results.

## Root Cause

In `src/evaluator/calls/comptime-fn.ts`, the `evaluateComptimeFunctionCall` function built its cache key from `argValues_.forallArgs` and `argValues_.args` but did NOT include `argValues_.variadicArgs`. This meant calls with different variadic args but the same regular args hit the same cache entry.

## Fix

Added `...argValues_.variadicArgs.map((v) => v.value)` to the `unfilteredArgValues` array in `comptime-fn.ts` so variadic arguments are included in the cache key.

## Files Changed

- `src/evaluator/calls/comptime-fn.ts`: Include variadic args in cache key
