#!/usr/bin/env python3
"""Narrow the comptime-overload preference gate from "operand not UnknownVal" to
"operand is a comptime LITERAL value" (IntLit / FloatLit / StrLit).

Rationale (see issues/yo-self-comptime-overload-preference.md): a BoolVal
produced by an unexpanded macro call (`Var.is_owning_the_rc_value(x)`, macro
dispatch is disabled in yo-self) passes the not-unknown test but its comptime
route still fails, which broke tests/iso and tests/rc.

Anchored on unique context; run once from the repo root.
"""
import sys

P = 'yo-self/evaluator/calls/function.yo'
s = open(P).read()

OLD = """      ca_conc := match(
        expr_info_table_get(ctx.expr_info_table, ast_expr_id(ca)),
        .Some(cinfo) => match(cinfo.value,.Some(cv) => !(is_unknown_val(cv)),.None => false),
        .None => false
      );"""
NEW = """      ca_conc := match(
        expr_info_table_get(ctx.expr_info_table, ast_expr_id(ca)),
        .Some(cinfo) => match(
          cinfo.value,
          .Some(cv) => match(
            cv,
            .IntLit(_) => true,
            .FloatLit(_) => true,
            .StrLit(_) => true,
            _ => false
          ),
          .None => false
        ),
        .None => false
      );"""

if OLD not in s:
    print('ANCHOR NOT FOUND — aborting', file=sys.stderr)
    sys.exit(1)
if s.count(OLD) != 1:
    print('ANCHOR NOT UNIQUE — aborting', file=sys.stderr)
    sys.exit(1)
s = s.replace(OLD, NEW)

# Retitle the comment block so it states the narrowed rule.
OLD_C = """  // Report whether EVERY argument evaluated to a concrete compile-time value
  // during this trial (present and not an `UnknownVal`). The comptime-candidate
  // preference below only applies when the operands can actually FOLD — the
  // same `op_operands_concrete` rule the infix-operator dispatch already uses
  // (function.yo's operator block). Reading the CLONES keeps the real exprs'
  // ExprInfo untouched."""
NEW_C = """  // Report whether EVERY argument evaluated to a comptime LITERAL value during
  // this trial (`IntLit` / `FloatLit` / `StrLit`). The comptime-candidate
  // preference below only applies then — see the DEVIATION note at that site
  // for why the bootstrap cannot yet honour the language's
  // comptime-beats-runtime rule for every operand shape. Reading the CLONES
  // keeps the real exprs' ExprInfo untouched."""
if OLD_C not in s:
    print('COMMENT ANCHOR NOT FOUND — aborting', file=sys.stderr)
    sys.exit(1)
s = s.replace(OLD_C, NEW_C)

open(P, 'w').write(s)
print('patched', P)
