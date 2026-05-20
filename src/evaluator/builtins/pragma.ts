import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  type Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { isEnumType } from "../../types/guards";
import { typeToString } from "../../types/utils";
import { VUnit } from "../../unit-value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { registerFilePragma, type PragmaKind } from "../memory-safety";

/**
 * Evaluate the `pragma(Pragma.X);` builtin.
 *
 * Used at the top of a Yo source file to declare per-file privilege
 * flags. The argument is evaluated normally and must yield a value
 * of the `Pragma` enum (defined in `std/prelude.yo`); the matched
 * variant is registered in the per-file pragma registry.
 *
 * Special case: `pragma(Pragma.SkipPrelude);` is also recognized by
 * an AST-level pre-scan (see `preScanProgramPragmas` below), because
 * that pragma takes effect BEFORE the prelude — and hence the
 * `Pragma` enum itself — is in scope. When the same line is later
 * evaluated, the registry already holds `SkipPrelude` and the
 * evaluator runs against whatever `Pragma` definition the file
 * provides (or skips evaluation if Pragma is unreachable — see the
 * fast path below).
 *
 * See plans/MEMORY_SAFETY.md.
 */
export function evaluatePragma({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.pragma, 1);

  const argExpr = expr.args[0]!;

  // Fast path: if the pre-scan already recognized and registered
  // this pragma call by AST shape (only `pragma(Pragma.SkipPrelude);`
  // qualifies — see `preScanProgramPragmas`), skip the evaluation
  // step entirely. The file may not have `Pragma` in scope at this
  // point (that's exactly what SkipPrelude implies), so attempting
  // to evaluate would just produce a confusing "Pragma undefined"
  // error. The pre-scan already did its job.
  const preScannedKind = recognizePragmaArgByAstShape(argExpr);
  if (preScannedKind === "SkipPrelude") {
    expr.$ = {
      env,
      type: VUnit.type,
      value: VUnit,
      pathCollection: [],
    };
    return expr;
  }

  // Normal path: evaluate the argument, then check it's a Pragma
  // enum variant. This catches typos, misuse (`pragma(42)`,
  // `pragma(SomeOtherEnum.X)`), and shadowed `Pragma` names.
  const evaluatedArg = evaluateExpression({
    expr: argExpr,
    env,
    context,
  });
  if (!evaluatedArg.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument of 'pragma(...)'.`,
    });
  }
  env = evaluatedArg.$.env;

  const argType = evaluatedArg.$.type;
  if (
    !isEnumType(argType) ||
    argType.typeName !== "Pragma" ||
    !argType.selectedVariantName
  ) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage:
        `'pragma(...)' expects a 'Pragma.X' argument (e.g. ` +
        `'pragma(Pragma.AllowUnsafe);'). Got value of type ` +
        `${typeToString(argType)} from: ${exprToString(argExpr)}`,
    });
  }

  const kind = pragmaKindFromVariantName(argType.selectedVariantName);
  if (!kind) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage:
        `Unknown 'Pragma' variant '${argType.selectedVariantName}'. ` +
        `The compiler does not recognize this pragma — make sure the ` +
        `prelude's 'Pragma' enum and 'src/evaluator/memory-safety.ts' ` +
        `agree on the set of supported variants.`,
    });
  }

  const modulePath = expr.token.modulePath;
  if (modulePath) {
    registerFilePragma(modulePath, kind);
  }

  // pragma(...) is a compile-time-only declaration; returns unit.
  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}

/**
 * Map a `Pragma` enum variant name (from the prelude) to its
 * compiler-side `PragmaKind`. Returns `null` if the variant name is
 * unknown to the compiler.
 *
 * Keep in sync with `Pragma :: enum(...)` in `std/prelude.yo` and
 * `PragmaKind` in `src/evaluator/memory-safety.ts`.
 */
function pragmaKindFromVariantName(variantName: string): PragmaKind | null {
  switch (variantName) {
    case "AllowUnsafe":
      return "AllowUnsafe";
    case "SkipPrelude":
      return "SkipPrelude";
    case "SkipWasm":
      return "SkipWasm";
    case "SkipWasm32Emscripten":
      return "SkipWasm32Emscripten";
    case "SkipWasm32Wasi":
      return "SkipWasm32Wasi";
    default:
      return null;
  }
}

/**
 * AST-level recognition of `pragma(Pragma.X)` argument shape, used by
 * the pre-prelude scanner below. This is intentionally limited: it
 * only matches the literal `Pragma.X` property-access shape, doesn't
 * resolve identifiers, and won't catch e.g. aliased imports. That's
 * fine — the pre-scan exists solely to detect things that MUST be
 * known before the prelude loads (`SkipPrelude`). All other pragmas
 * are validated by full evaluation in `evaluatePragma` above.
 */
function recognizePragmaArgByAstShape(
  argExpr: FnCallExpr["args"][number]
): PragmaKind | null {
  // Property access in Yo is parsed as a `.` function call:
  //   `Pragma.AllowUnsafe`  ==>  ".".call(Pragma, AllowUnsafe)
  if (!exprIsFunctionCall(argExpr)) return null;
  if (!exprIsFunctionCallOf(argExpr, ".", 2)) return null;
  const lhs = argExpr.args[0];
  const rhs = argExpr.args[1];
  if (!lhs || !rhs) return null;
  if (!exprIsAtom(lhs) || lhs.token.value !== "Pragma") return null;
  if (!exprIsAtom(rhs)) return null;
  return pragmaKindFromVariantName(rhs.token.value);
}

/**
 * Pre-evaluation scan for `pragma(Pragma.SkipPrelude);`.
 *
 * Runs before the prelude is auto-loaded so that files declaring
 * `SkipPrelude` can opt out of the implicit prelude import. Only
 * `SkipPrelude` is registered here — all other pragmas go through
 * full evaluation in `evaluatePragma`, where they get proper type
 * checking against the `Pragma` enum.
 *
 * Only scans top-level expressions. Pragma calls nested inside
 * function bodies or blocks are not pre-scanned (they couldn't
 * meaningfully affect prelude loading anyway).
 */
export function preScanForSkipPrelude(
  program: Expr[],
  modulePath: string
): boolean {
  let foundSkipPrelude = false;
  for (const expr of program) {
    if (!exprIsFunctionCall(expr)) continue;
    if (!exprIsFunctionCallOf(expr, BuiltinFunctions.pragma)) continue;
    if (expr.args.length !== 1) continue;
    const kind = recognizePragmaArgByAstShape(expr.args[0]!);
    if (kind === "SkipPrelude") {
      registerFilePragma(modulePath, "SkipPrelude");
      foundSkipPrelude = true;
    }
  }
  return foundSkipPrelude;
}
