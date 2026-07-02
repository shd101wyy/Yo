# cond/match arm: the word `return` inside a string literal skipped the result assignment (SIGBUS)

**Status:** FIXED (2026-07-02). Regression test:
`tests/cond_return_in_string_literal.test.yo`.

## Error

The self-hosted compiler's emit-C self-compile crashed with SIGBUS (exit 138)
in `generate_pending_deferred_drops → String.push_str →
ArrayList(u8).extend_from_ptr → memmove` reading a wild source address —
`push_str` received an **uninitialized `__yo_str` (garbage ptr/len)**.

## Minimal reproducer (`src/tests/fixme.yo` at the time)

```rust
helper :: (fn(is_completion : bool, indent : String, xs : Option(ArrayList(usize))) -> unit)(
  match(
    xs,
    .Some(pending) => if(pending.len() > usize(0), {
      msg := indent.clone();
      msg.push_str(if(is_completion, "// Drop local variables before early completion", "// Drop local variables before early return"));
      println(msg);
    }),
    .None => ()
  )
);
// helper(false, ...) → rc=139
```

Emitted C (the bug, verbatim):

```c
__yo_str temp;
if (is_completion) {
  temp = (__yo_str){ .ptr = ..."...early completion", .len = 47 };
} else {
  (__yo_str){ .ptr = ..."...early return", .len = 43 };   // constructed, NEVER assigned
}
push_str(&msg, temp);                                      // uninitialized on the else path
```

## Root cause

`src/codegen/exprs/cond.ts` (4 sites) and `match.ts`'s `isControlFlowCode`
classify a generated arm as CONTROL FLOW (emit bare, skip the result-temp
assignment) when the generated code matches `/\breturn\b/`. The word-boundary
was added earlier for identifiers like `return_flag`
(issue: struct-literal-in-match-arm-not-assigned), but the scan still matched
the word `return` **inside generated C string literals** — e.g. any Yo source
string containing "…early return". The arm is then emitted as a bare
expression statement and the result temp stays uninitialized.

Bisect fingerprint: `"AAA"/"...early return"` crashed;
`"...early completion"/"BBB"` didn't; the `//` prefix was irrelevant.

## Fix

- TS: `codeContainsReturnStatement(code)` (`src/codegen/utils/index.ts`) —
  masks double-quoted C string literals (escape-aware) before the
  `\breturn\b` scan. All 5 heuristic sites switched to it.
- yo-self mirror: `_inside_c_string_literal(s, idx)` parity-walk added to the
  `_contains_word_return` helpers in `codegen/exprs/cond.yo` and
  `codegen/exprs/match.yo`; a word match inside a literal no longer counts.

## Notes

Text-scanning generated code for control flow remains inherently fragile —
the durable fix is tracking "arm ends in control flow" structurally during
generation. Recorded here as future hardening; the masking closes every
currently-known false positive (identifiers, string literals).
