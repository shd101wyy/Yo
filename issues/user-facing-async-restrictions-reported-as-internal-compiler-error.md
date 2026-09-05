# A user's typo in an `io.async` body is reported as `internal compiler error … This is a bug in the Yo compiler, not in your program`

**Status:** OPEN
**Severity:** api-lie. Four documented, deliberate, user-facing async
restrictions are printed with the ICE prefix and a "please file a bug against
the compiler" URL. They also lose their E-code, their caret/source line, and
`--error-format json` entirely — even though the codes (`E0904`, `E0905`) and
their `yo explain` entries already exist in the tree.
**Found:** 2026-09-04, std-API audit re-measurement, while distilling `io.async`
reproducers.

## Symptom 1 — the await-placement restriction

```rust
{ println } :: import("std/fmt");

inner :: (fn(io : Io, n : i32) -> Impl(Future(i32)))(io.async((e : Io) => (n + 1)));

outer :: (fn(io : Io) -> Impl(Future(i32)))(
  io.async(
    (e : Io) => cond(
      false => i32(0),
      (e.await(inner(e, 1), e) == 2) => i32(10),
      true => i32(20)
    )
  )
);

main :: (fn(io : Io) -> unit)({
  v := io.await(outer(io), io);
  println(v.to_string())
});

export(main);
```

```
$ yo compile condawait.yo --emit-c --skip-c-compiler
yo: error: internal compiler error: condawait.yo:7:17: `io.await` in a `cond` condition inside an `io.async` block must BE the first condition — it cannot be nested inside a larger expression, and it cannot be in a later branch.
A later branch's condition is only evaluated if the earlier ones fail, so hoisting it would await even when an earlier branch matches.
Bind it to a local first:
    ready := io.await(f, io);
    cond(c1 => ..., !(ready) => ..., true => ...)
(note this evaluates the await unconditionally, which is why the compiler will not do it for you).
This is a bug in the Yo compiler, not in your program — please report it:
https://github.com/shd101wyy/Yo/issues
```

The message body is excellent — rule, reason, and a worked fix. Everything
wrapped around it is false. This restriction is documented in `AGENTS.md`
("`io.await` in a cond condition must BE the first condition") and enforced on
purpose; the user broke a language rule, the compiler did not crash.

## Symptom 2 — the same family, generic await position

```rust
outer :: (fn(io : Io) -> Impl(Future(i32)))(
  io.async((e : Io) => (e.await(inner(e, 1), e) + 1))
);
```

```
yo: error: internal compiler error: awaitpos.yo:6:49: `io.await` is not supported in this position inside an `io.async` block (expression: FnCall, function: `+`).
Hoist it into a local first: `result := io.await(f, io);`
This is a bug in the Yo compiler, not in your program — please report it:
https://github.com/shd101wyy/Yo/issues
```

## Symptom 3 — a plain typo in an async body

```rust
{ println } :: import("std/fmt");

outer :: (fn(io : Io) -> Impl(Future(i32)))(
  io.async((e : Io) => i32(1).no_such_method())
);

main :: (fn(io : Io) -> unit)({
  v := io.await(outer(io), io);
  println(v.to_string())
});

export(main);
```

```
yo: error: internal compiler error: hollow2.yo:4:30: this `io.async` closure's body was never fully evaluated — an error inside it was deferred at definition time and never re-checked, so the emitted sync-future future would run nothing and silently complete.
Fix the error inside the body. Common causes: a type error the deferred trial swallowed, a forward reference (move the definition above its use), or a call with the wrong argument count.
This is a bug in the Yo compiler, not in your program — please report it:
https://github.com/shd101wyy/Yo/issues
```

A misspelled method name. The message even says "Fix the error inside the body"
and is then contradicted two lines later by "not in your program".

## Symptom 4 — the machine-readable channel is empty for the whole class

```
$ yo --error-format json compile condawait.yo --emit-c --skip-c-compiler
yo: error: internal compiler error: condawait.yo:7:17: `io.await` in a `cond` …
```

No JSON. `--error-format short` produces the same. The LSP, and anything else
parsing structured diagnostics, sees nothing for this class.

## Root cause

Every one of these messages is routed through `codegen_fatal`
(`src/codegen/constants.yo:204-215`), which unconditionally wraps its argument:

```rust
codegen_fatal :: (fn(message : String) -> unit)({
  wrapped := `internal compiler error: ${message}\nThis is a bug in the Yo compiler, not in your program — please report it:\nhttps://github.com/shd101wyy/Yo/issues`;
  …
  exn.throw(dyn(wrapped));
```

The wrapper is D11 of `plans/reference/ERROR_DIAGNOSTICS_OVERHAUL.md` (§7 P3
item 4), and its premise — recorded verbatim in the doc comment above
`codegen_fatal_expr` — is that "every one of those sites is an internal emitter
precondition … none is reachable from source the evaluator accepted". That
premise holds for ~145 of the sites and is **false for four**:

| site | message builder | reachable by |
| --- | --- | --- |
| `src/codegen/async/state_code_gen.yo:1213` | `_unsupported_await_message` (`:991`) | an `io.await` in an unsplittable position |
| `src/codegen/async/state_code_gen.yo:2566` | `_unsupported_await_message` (`:991`) | an `io.await` in a later `cond` condition |
| `src/codegen/exprs/async.yo:1757` | `_hollow_async_body_message` (`:1727`) | any error inside an `io.async` body (FSM path) |
| `src/codegen/exprs/async.yo:2594` | `_hollow_async_body_message` (`:1727`) | any error inside an `io.async` body (sync path) |

Both builders compute a `where` prefix from the USER's token
(`${t.module_path}:${row+1}:${column+1}`) and write fix advice for the user —
they are user diagnostics that happen to be raised in codegen because that is
where the state-machine splitter runs.

`codegen_fatal` throws a plain `String`, not a `YoError`, so the CLI edge
(`src/main.yo:4706-4717`) takes its `.None` arm and prints
`yo: error: <text>` — no code, no caret, no source line, and no honouring of
`--error-format`.

The codes already exist and are already wired for these two messages:

- `src/diagnostics.yo:75` — `E_AWAIT_PLACEMENT :: "E0904"`;
  `src/diagnostics.yo:76` — `E_NEVER_FULLY_EVALUATED :: "E0905"`.
- `src/error.yo:171` classifies any message containing
  `"must BE the first condition"` as `E0904`; `src/error.yo:174` classifies
  `"was never fully evaluated"` as `E0905`.
- `src/diagnostics_registry.yo:395-410` carries a full bilingual `yo explain`
  entry for `E0904`, and `:410-425` does the same for `E0905`.

`yo explain E0904` and `yo explain E0905` both print correctly today. The
classification path in `src/error.yo:89` (`_classify_message`) is simply never
reached, because it runs on `Diagnostic` construction and `codegen_fatal` never
builds one.

Note the third `_unsupported_await_message` form — "`io.await` is not supported
in this position" (Symptom 2) — has no classifier entry at all, so it needs one
as part of the fix.

## Fix

1. Add a `codegen_user_error` next to `codegen_fatal` in
   `src/codegen/constants.yo` that builds a `YoError` from a `Token` + message +
   E-code (the same builder the evaluator's ~1000 emission sites use) and throws
   THAT. No ICE prefix, no report prompt. The CLI edge's `downcast(err, YoError)`
   arm (`src/main.yo:4706`) then renders it in the process's error format for
   free, with the caret and source line, and `--error-format json` starts
   working.
2. Change the message builders to return the message WITHOUT the baked-in
   `module_path:row:col` prefix and to hand their `Token` to the new function —
   `_unsupported_await_message` (`src/codegen/async/state_code_gen.yo:991`) and
   `_hollow_async_body_message` (`src/codegen/exprs/async.yo:1727`) both already
   compute the token. A location baked into the message string is exactly D1 of
   the diagnostics overhaul, which P1 removed everywhere else.
3. Convert the four call sites above. Leave the other ~145 `codegen_fatal` sites
   alone — they really are internal preconditions.
4. Add the classifier entry for the third await-position form ("is not supported
   in this position inside an `io.async` block") so it also lands on `E0904`, and
   extend the `E0904` explain entry to mention it.

Design choice, worth stating: `E0904` currently describes only the `cond`-first
restriction. Either broaden it to the whole "await placement" family (recommended
— the code name `E_AWAIT_PLACEMENT` already says so), or split the
"unsupported position" form into its own code. Broadening keeps
`yo explain E0904` a single page for one user-facing rule.

## Regression test

- `tests/cli-cases/await-in-later-cond-branch/` already covers Symptom 1 and its
  `opts` uses `stdout_keep_match=must BE the first condition`, so it will keep
  passing across the prefix change. Tighten it: add
  `error[E0904]` to the kept match, and re-record the golden
  (`scripts/cli-diff-test.sh --record`) — and run `yo fmt` on the fixture first,
  since the CI fmt gate scans `tests/cli-cases` fixtures and the tree hash is in
  `expected_tree`.
- Add `tests/cli-cases/async-body-typo-is-not-an-ice/` for Symptom 3, asserting
  rc=1 and a `stdout_keep_match` on `error[E0905]`.
- Add a negative assertion somewhere in the CLI corpus — a case whose kept match
  is that the output does NOT contain `internal compiler error` for a program
  with an ordinary async mistake. `tests/internal/diagnostics_registry.test.yo`
  is the natural home for asserting that `E0904` and `E0905` are actually
  produced by the compiler and not just declared.

Verify red-first on all three: today they emit `internal compiler error` and no
E-code.
