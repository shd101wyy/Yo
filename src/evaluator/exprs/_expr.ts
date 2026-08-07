import { type Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  BuiltinKeywords,
  type Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { TokenType } from "../../token";
import { evaluateAlignOf } from "../builtins/alignof";
import { evaluateAndOr } from "../builtins/and-or";
import { evaluateYoArrayFill } from "../builtins/array-fns";
import { evaluateComptimeAssert } from "../builtins/comptime-assert";
import { evaluateYoComptimeBooleanFunctions } from "../builtins/comptime-bool-fns";
import { evaluateComptimeExpectError } from "../builtins/comptime-expect-error";
import { evaluateComptimeFn } from "../builtins/comptime-fn";
import {
  evaluateYoComptimeListAppend,
  evaluateYoComptimeListCar,
  evaluateYoComptimeListCdr,
  evaluateYoComptimeListCons,
  evaluateYoComptimeListElementType,
  evaluateYoComptimeListGet,
  evaluateYoComptimeListLength,
} from "../builtins/comptime-list-fns";
import { evaluateYoComptimeNumericFunctions } from "../builtins/comptime-numeric-fns";
import { evaluateComptimePrint } from "../builtins/comptime-print";
import { evaluateYoComptimeStringFunctions } from "../builtins/comptime-string-fns";
import { evaluateYoComptimeIndexFunctions } from "../builtins/comptime-index-fns";
import { evaluateConsume } from "../builtins/consume";
import {
  evaluateEnsures,
  evaluateGhost,
  evaluateGhostFn,
  evaluateInvariant,
  evaluateOld,
  evaluateRequires,
} from "../builtins/contracts";
import { evaluatePragma } from "../builtins/pragma";
import { evaluateUnsafe } from "../builtins/unsafe";
import { isImplicitlyUnsafeCapableFile } from "../memory-safety";
import { evaluateDowncast } from "../builtins/downcast";
import { evaluateDrop } from "../builtins/drop";
import { evaluateDup } from "../builtins/dup";
import {
  evaluateYoExprEq,
  evaluateYoExprGetArgs,
  evaluateYoExprGetCallee,
  evaluateYoExprIsAtom,
  evaluateYoExprIsFnCall,
  evaluateYoExprToString,
} from "../builtins/expr-fns";
import { evaluateYoGcCollect } from "../builtins/gc";
import { evaluateGensym } from "../builtins/gensym";
import { evaluateImplConstraint } from "../builtins/impl-constraint";
import { evaluateMacroExpand } from "../builtins/macro-expand";
import { evaluatePanic } from "../builtins/panic";
import { evaluateAsm, evaluateGlobalAsm } from "../builtins/asm";
import { evaluateYoProcessFunctions } from "../builtins/process";
import { evaluateYoBuildFunctions } from "../builtins/build";
import { evaluateAddressCall } from "../builtins/ptr-fns";
import { evaluateQuote } from "../builtins/quote";
import { evaluateRc } from "../builtins/rc";
import {
  evaluateYoDecrRc,
  evaluateYoDecrRcAtomic,
  evaluateYoDropArrayElement,
  evaluateYoDropTupleElement,
  evaluateYoDupArrayElement,
  evaluateYoDupTupleElement,
  evaluateYoDynVtableDrop,
  evaluateYoDynVtableDup,
  evaluateYoIncrRc,
  evaluateYoIncrRcAtomic,
  evaluateYoIsoDispose,
  evaluateYoIsoExtract,
  evaluateYoRcOwn,
  evaluateYoSomeTypeDrop,
  evaluateYoSomeTypeDup,
} from "../builtins/rc-fns";
import { evaluateSizeOf } from "../builtins/sizeof";
import { evaluateThe } from "../builtins/the";
import {
  evaluateYoAreTypesCompatible,
  evaluateYoAreTypesEqual,
  evaluateYoTypeCanFormRcCycle,
  evaluateYoTypeContainsRcType,
  evaluateYoTypeImpls,
  evaluateYoTypeToString,
  evaluateYoTypeGetInfo,
  evaluateComptimeEval,
  evaluateComptimeStringToExpr,
  evaluateTypeJoinFields,
  evaluateTypeMapVariants,
} from "../builtins/type-fns";
import { evaluateDerive } from "../builtins/derive";
import { evaluateDeriveRule } from "../builtins/derive-rule";
import { evaluateTypeId } from "../builtins/typeid";
import { evaluateVaStart } from "../builtins/va-start";
import {
  evaluateYoVarHasOtherAliases,
  evaluateYoVarIsOwningTheRcValue,
  evaluateYoVarPrintInfo,
} from "../builtins/var-fns";
import { evaluateFunctionCall } from "../calls/function";
import { evaluateIsoTypeCall } from "../calls/iso";
import { evaluateRawPointerCall } from "../calls/pointer";
import type { EvaluatorContext } from "../context";
import { evaluateArrayType } from "../types/array";
import { evaluateClosureType } from "../types/closure";
import { evaluateComptimeListType } from "../types/comptime-list";
import { evaluateConcreteType } from "../types/concrete-trait";
import { evaluateDynType } from "../types/dyn";
import { evaluateEnumType } from "../types/enum";
import { evaluateFnTraitType } from "../types/fn-trait";
import { evaluateFunctionType } from "../types/function";
import { evaluateFutureType } from "../types/future-trait";
import { evaluateNewtypeType } from "../types/newtype";
import { evaluateStructType } from "../types/struct";
import { evaluateTraitType } from "../types/trait";
import { evaluateTupleType } from "../types/tuple";
import { evaluateUnionType } from "../types/union";
import { evaluateAnonymousFunctionImplementation } from "../values/anonymous-function";
import { evaluateArrayValue } from "../values/array";
import { evaluateBooleanLiteral } from "../values/boolean";
import { evaluateCharLiteral } from "../values/char";
import { evaluateComptimeListValue } from "../values/comptime-list";
import { evaluateDynValue } from "../values/dyn";
import { evaluateFloatLiteral } from "../values/float";
import { evaluateImplBlock } from "../values/impl";
import { evaluateIntegerLiteral } from "../values/integer";
import { evaluateStringLiteral } from "../values/string";
import { evaluateTupleValue } from "../values/tuple";
import { evaluateAssignment } from "./assignment";
import { evaluateBeginExpression } from "./begin";
import { evaluateBinding } from "./binding";
import { evaluateCInclude } from "./c-include";
import { evaluateCond } from "./cond";
import { evaluateUnwind } from "./unwind";
import { evaluateExtern } from "./extern";
import { evaluateIdentifierAndOperator } from "./identifer-and-operator";
import { evaluateImport } from "./import";
import { evaluateInitializationAssignment } from "./initialization-assignment";
import { evaluateMatch } from "./match";
import { evaluateOpen } from "./open";
import { evaluatePropertyAccess } from "./property-access";
import { evaluateRecur } from "./recur";
import { evaluateRuntime } from "./runtime";
import { evaluateSubtypeOf } from "./subtype-of";
import { evaluateTest } from "./test";
import { evaluateTypeOf } from "./typeof";
import { evaluateWhile } from "./while";

function isDebugFlagEnabled(name: string): boolean {
  const value = process.env[name];
  return value === "1" || value?.toLowerCase() === "true";
}

const isEvalProfilerEnabled =
  isDebugFlagEnabled("YO_DEBUG_EVAL") ||
  isDebugFlagEnabled("YO_DEBUG_EVAL_PROFILE");

type EvalProfilerGlobalState = {
  __yoEvalProfilerState?: {
    evalCount: number;
    evalStart: number;
  };
};

const _ge: typeof globalThis & EvalProfilerGlobalState = globalThis;
const _evalProfilerState =
  _ge.__yoEvalProfilerState ??
  (_ge.__yoEvalProfilerState = { evalCount: 0, evalStart: 0 });
export function _resetEvalProfiler() {
  if (!isEvalProfilerEnabled) {
    return;
  }
  _evalProfilerState.evalCount = 0;
  _evalProfilerState.evalStart = Date.now();
}
export function _printEvalProfile() {
  if (!isEvalProfilerEnabled) {
    return;
  }
  if (!_evalProfilerState.evalStart) {
    _evalProfilerState.evalStart = Date.now();
  }
  console.log(
    `[EVAL PROFILE] ${_evalProfilerState.evalCount} evaluateExpression calls in ${Date.now() - _evalProfilerState.evalStart}ms`
  );
}

// ---------------------------------------------------------------------------
// Cooperative evaluation deadline — test-RUNNER infrastructure, not language
// semantics (no yo-self mirror until the runner itself is ported; see
// issues/fixed/test-runner-no-compile-timeout.md).
//
// Sequential test mode (`--parallel 1`) runs the Yo→C compile synchronously
// in-process, where a hung evaluator (e.g. runaway comptime recursion)
// cannot be interrupted from outside the thread. The runner arms a wall-clock
// deadline before compiling; the dispatch hot path checks it every 16384
// calls and throws past it. The throw is NOT one-shot: swallowing layers
// (trial-eval) may catch it, but every subsequent evaluation re-throws
// within another 16384 dispatches, so the compile unwinds to completion
// (as a compile error) instead of hanging forever.
// ---------------------------------------------------------------------------
let _evalDeadlineMs = 0;
let _evalDeadlineCounter = 0;

export function setEvaluatorDeadline(deadlineMs: number | undefined): void {
  _evalDeadlineMs = deadlineMs ?? 0;
  _evalDeadlineCounter = 0;
}

export function _evaluateExpression({
  expr,
  env,
  context,
}: {
  expr: Expr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  if (
    _evalDeadlineMs !== 0 &&
    (++_evalDeadlineCounter & 0x3fff) === 0 &&
    Date.now() > _evalDeadlineMs
  ) {
    throw new Error(
      `Yo compilation exceeded the configured time limit (possible evaluator hang). See issues/fixed/test-runner-no-compile-timeout.md.`
    );
  }
  if (isEvalProfilerEnabled) {
    if (!_evalProfilerState.evalStart) {
      _evalProfilerState.evalStart = Date.now();
    }
    _evalProfilerState.evalCount++;
    if (_evalProfilerState.evalCount % 100000 === 0) {
      console.log(
        `[EVAL] ${_evalProfilerState.evalCount} calls, ${Date.now() - _evalProfilerState.evalStart}ms elapsed`
      );
    }
  }
  if (exprIsAtom(expr)) {
    switch (expr.token.type) {
      case TokenType.Identifier:
      case TokenType.Operator: {
        return evaluateIdentifierAndOperator({
          expr,
          env,
          context: { ...context },
          throwErrorOnUndefined: true,
        });
      }
      case TokenType.Integer: {
        return evaluateIntegerLiteral(expr, env, { ...context });
      }
      case TokenType.Float: {
        return evaluateFloatLiteral(expr, env, { ...context });
      }
      case TokenType.String: {
        return evaluateStringLiteral(expr, env);
      }
      case TokenType.Char: {
        return evaluateCharLiteral(expr, env);
      }
      case TokenType.Bool: {
        return evaluateBooleanLiteral(expr, env);
      }
      default: {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `(1) Evaluating the expression (tag: ${expr.tag}, token: ${expr.token.type}) below is not implemented:
${exprToString(expr)}`,
        });
      }
    }
  } else {
    if (exprIsFunctionCallOf(expr, ":", 2)) {
      // Binding type
      const { expr: nextExpr } = evaluateBinding({ expr, env, context });
      return nextExpr;
    } else if (
      exprIsFunctionCallOf(expr, ":=", 2) ||
      exprIsFunctionCallOf(expr, "::", 2)
    ) {
      // Initialize assignment
      return evaluateInitializationAssignment({ expr, env, context });
    } else if (exprIsFunctionCallOf(expr, "=", 2)) {
      // Assignment
      return evaluateAssignment({ expr, env, context });
    } else if (exprIsFunctionCallOf(expr, "->", 2)) {
      // Function type
      if (
        // (fn(x : i32) -> i32), (ctl(x : i32) -> i32), or unsafe_fn(...)
        exprIsFunctionCall(expr.args[0]) &&
        (exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.fn) ||
          exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.ctl) ||
          exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.unsafe_fn))
      ) {
        return evaluateFunctionType({
          expr,
          env,
          context: {
            ...context,
            isUnsafeFunctionType: exprIsFunctionCallOf(
              expr.args[0],
              BuiltinKeywords.unsafe_fn
            ),
            isControlFunctionType: exprIsFunctionCallOf(
              expr.args[0],
              BuiltinKeywords.ctl
            ),
          },
        });
      }

      // Fn trait type (trait for callable types)
      // Fn(x : i32) -> i32
      if (
        exprIsFunctionCall(expr.args[0]) &&
        exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.Fn)
      ) {
        return evaluateFnTraitType({
          expr,
          env,
          context: { ...context },
        });
      }

      // Anonymous function implementation
      // (x) -> x;
      return evaluateAnonymousFunctionImplementation({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, "=>", 2)) {
      // Closure type or closure implementation
      if (
        // fn(x : i32) => i32 - Closure type
        exprIsFunctionCall(expr.args[0]) &&
        exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.fn)
      ) {
        // Handle closure type directly without transformation
        return evaluateClosureType({
          expr,
          env,
          context: { ...context },
        });
      }

      // Anonymous closure implementation
      // (x) => x;
      return evaluateAnonymousFunctionImplementation({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, "=>>", 2)) {
      // Fn/FnMut closure implementation (borrow semantics)
      // (x) =>> x;
      return evaluateAnonymousFunctionImplementation({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.recur)) {
      // recur
      return evaluateRecur({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.runtime)) {
      // runtime - force runtime evaluation, prevents CTFE
      return evaluateRuntime({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.extern)) {
      // extern
      return evaluateExtern({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.c_include)) {
      // c_include
      return evaluateCInclude({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.test)) {
      // test - no-op during normal compilation, used by test runner
      return evaluateTest({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.cond)) {
      // cond
      return evaluateCond({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.match)) {
      // match
      return evaluateMatch({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.tuple)) {
      // tuple
      return evaluateTupleValue({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.array)) {
      // array
      return evaluateArrayValue({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.comptime_list)) {
      // comptime_list
      return evaluateComptimeListValue({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.dyn)) {
      // dyn
      return evaluateDynValue({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.atomic)) {
      // atomic(ref(struct(...))) — atomic reference-counted reference type
      // (thread-safe RC, cycles disallowed). `atomic(object(...))` is the
      // deprecated spelling. plans/REF_REFERENCE_SEMANTICS.md Phase 2.
      if (expr.args.length !== 1) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `"atomic" expects exactly one argument: atomic(ref(struct(...)))`,
        });
      }
      const innerExpr = expr.args[0]!;
      let result: FnCallExpr;
      if (
        exprIsFunctionCall(innerExpr) &&
        exprIsFunctionCallOf(innerExpr, BuiltinKeywords.ref)
      ) {
        // atomic(ref(struct(...))) — the canonical form. `ref` wraps an inline
        // `struct(...)` literal (enum support is Phase 3).
        if (innerExpr.args.length !== 1) {
          throw formatErrorMessage({
            token: innerExpr.token,
            errorMessage: `"ref" expects exactly one argument: ref(struct(...))`,
          });
        }
        const refInner = innerExpr.args[0]!;
        if (
          exprIsFunctionCall(refInner) &&
          exprIsFunctionCallOf(refInner, BuiltinKeywords.struct)
        ) {
          result = evaluateStructType({
            expr: refInner,
            env,
            context: { ...context },
            isAtomicRc: true,
            forceReferenceSemantics: true,
          });
        } else if (
          exprIsFunctionCall(refInner) &&
          exprIsFunctionCallOf(refInner, BuiltinKeywords.enum)
        ) {
          result = evaluateEnumType({
            expr: refInner,
            env,
            context: { ...context },
            isAtomicRc: true,
            forceReferenceSemantics: true,
          });
        } else {
          throw formatErrorMessage({
            token: refInner.token,
            errorMessage: `"atomic(ref(...))" wraps an inline "struct(...)" or "enum(...)" literal. Got:\n${exprToString(refInner)}`,
          });
        }
        // Stamp both the ref(...) node and the outer atomic(...) node.
        innerExpr.$ = result.$;
        innerExpr.func.$ = result.$;
      } else {
        throw formatErrorMessage({
          token: innerExpr.token,
          errorMessage: `"atomic" modifier is only valid before "ref(struct(...))". Got:\n${exprToString(innerExpr)}`,
        });
      }
      // Propagate the evaluated result back to the atomic expr
      expr.$ = result.$;
      expr.func.$ = result.$;
      return expr;
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.ref)) {
      // ref(struct(...)) / ref(enum(...)) — reference-semantics type
      // constructor. `ref` wraps an inline struct/enum literal only.
      // plans/REF_REFERENCE_SEMANTICS.md.
      if (expr.args.length !== 1) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `"ref" expects exactly one argument: ref(struct(...)) or ref(enum(...))`,
        });
      }
      const refInner = expr.args[0]!;
      let result: FnCallExpr;
      if (
        exprIsFunctionCall(refInner) &&
        exprIsFunctionCallOf(refInner, BuiltinKeywords.struct)
      ) {
        result = evaluateStructType({
          expr: refInner,
          env,
          context: { ...context },
          forceReferenceSemantics: true,
        });
      } else if (
        exprIsFunctionCall(refInner) &&
        exprIsFunctionCallOf(refInner, BuiltinKeywords.enum)
      ) {
        result = evaluateEnumType({
          expr: refInner,
          env,
          context: { ...context },
          forceReferenceSemantics: true,
        });
      } else {
        throw formatErrorMessage({
          token: refInner.token,
          errorMessage: `"ref(...)" wraps an inline "struct(...)" or "enum(...)" literal. Got:\n${exprToString(refInner)}`,
        });
      }
      // Propagate the inner type's evaluated info to the ref(...) node.
      expr.$ = result.$;
      expr.func.$ = result.$;
      return expr;
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.struct)) {
      // struct
      return evaluateStructType({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.newtype)) {
      // newtype (single element struct)
      return evaluateNewtypeType({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.enum)) {
      // enum
      return evaluateEnumType({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.union)) {
      // union
      return evaluateUnionType({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, ".")) {
      // property access
      return evaluatePropertyAccess({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.begin)) {
      // begin
      return evaluateBeginExpression({
        expr,
        env,
        context: { ...context },
        variablesToAdd: [],
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.trait)) {
      // trait type
      return evaluateTraitType({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Impl)) {
      // Impl constraint type
      return evaluateImplConstraint({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.impl)) {
      // struct record value implementation
      return evaluateImplBlock({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.typeof)) {
      // typeof
      return evaluateTypeOf({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.sizeof)) {
      // sizeof
      return evaluateSizeOf({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.alignof)) {
      // alignof
      return evaluateAlignOf({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.typeid)) {
      // typeid
      return evaluateTypeId({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.downcast)) {
      // downcast
      return evaluateDowncast({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.rc)) {
      // rc
      return evaluateRc({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, "<:")) {
      // <: subtype_of
      return evaluateSubtypeOf({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.the)) {
      // the
      return evaluateThe({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.import)) {
      // import
      return evaluateImport({
        expr,
        env,
        context: { ...context },
        stdPath: context.stdPath,
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.open)) {
      // open
      return evaluateOpen({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Ptr, 1)) {
      // * pointer type
      return evaluateRawPointerCall({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Iso, 1)) {
      // Iso isolated type
      return evaluateIsoTypeCall({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_address_of, 1)
    ) {
      // & pointer value
      return evaluateAddressCall({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Tuple)) {
      // Tuple type
      return evaluateTupleType({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Array)) {
      // Array type
      return evaluateArrayType({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_array_fill, 2)
    ) {
      // __yo_array_fill
      return evaluateYoArrayFill({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.ComptimeList)) {
      // ComptimeList type
      return evaluateComptimeListType({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Future)) {
      // Future type
      return evaluateFutureType({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Concrete)) {
      // Concrete type (marker for resolvedConcreteType in Impl)
      return evaluateConcreteType({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Dyn)) {
      // Dyn type
      return evaluateDynType({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.comptime_expect_error)
    ) {
      // comptime_expect_error
      return evaluateComptimeExpectError({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.comptime_assert)) {
      // comptime_assert
      return evaluateComptimeAssert({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.comptime_fn)) {
      // comptime_fn
      return evaluateComptimeFn({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.comptime_print)) {
      // comptime_print
      return evaluateComptimePrint({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_panic)) {
      // panic
      return evaluatePanic({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.asm)) {
      // inline assembly
      return evaluateAsm({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.global_asm)) {
      // global assembly
      return evaluateGlobalAsm({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.macro_expand)) {
      // macro_expand
      return evaluateMacroExpand({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinKeywords.op_and) ||
      exprIsFunctionCallOf(expr, BuiltinKeywords.op_or)
    ) {
      // && ||
      return evaluateAndOr({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.unwind)) {
      // escape
      return evaluateUnwind({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.consume)) {
      // consume
      return evaluateConsume({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.unsafe)) {
      // unsafe
      return evaluateUnsafe({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.pragma)) {
      // pragma — file-level privilege declaration
      return evaluatePragma({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.requires)) {
      // requires — Phase 0 no-op contract marker
      return evaluateRequires({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.ensures)) {
      // ensures — Phase 0 no-op contract marker
      return evaluateEnsures({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.invariant)) {
      // invariant — Phase 0 no-op contract marker
      return evaluateInvariant({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.ghost)) {
      // ghost — Phase 0 no-op contract marker (binding form)
      return evaluateGhost({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.ghost_fn)) {
      // ghost_fn — Phase 0 transparent pass-through for ghost functions
      return evaluateGhostFn({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.old)) {
      // old — Phase 0 transparent pass-through; scope restriction TBD
      return evaluateOld({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.___drop)) {
      // ___drop
      return evaluateDrop({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.___dup)) {
      // ___dup
      return evaluateDup({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_decr_rc)) {
      // __yo_decr_rc
      return evaluateYoDecrRc({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_incr_rc)) {
      // __yo_incr_rc
      return evaluateYoIncrRc({ expr, env, context: { ...context } });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_decr_rc_atomic)
    ) {
      // __yo_decr_rc_atomic (for Iso types)
      return evaluateYoDecrRcAtomic({ expr, env, context: { ...context } });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_incr_rc_atomic)
    ) {
      // __yo_incr_rc_atomic (for Iso types)
      return evaluateYoIncrRcAtomic({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_iso_extract)) {
      // __yo_iso_extract (extract inner value from Iso)
      return evaluateYoIsoExtract({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_iso_dispose)) {
      // __yo_iso_dispose (dispose inner value of Iso if not extracted)
      return evaluateYoIsoDispose({ expr, env, context: { ...context } });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_drop_array_element)
    ) {
      // __yo_drop_array_element (drop array element at index without borrowing)
      return evaluateYoDropArrayElement({ expr, env, context: { ...context } });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_dup_array_element)
    ) {
      // __yo_dup_array_element (dup array element at index without borrowing)
      return evaluateYoDupArrayElement({ expr, env, context: { ...context } });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_drop_tuple_element)
    ) {
      // __yo_drop_tuple_element (drop tuple element at index without borrowing)
      return evaluateYoDropTupleElement({ expr, env, context: { ...context } });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_dup_tuple_element)
    ) {
      // __yo_dup_tuple_element (dup tuple element at index without borrowing)
      return evaluateYoDupTupleElement({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_rc_own)) {
      // __yo_rc_own
      return evaluateYoRcOwn({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_dyn_drop)) {
      // __yo_dyn_drop
      return evaluateYoDynVtableDrop({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_dyn_dup)) {
      // __yo_dyn_dup
      return evaluateYoDynVtableDup({ expr, env, context: { ...context } });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_sometype_drop)
    ) {
      // __yo_sometype_drop
      return evaluateYoSomeTypeDrop({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_sometype_dup)) {
      // __yo_sometype_dup
      return evaluateYoSomeTypeDup({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_gc_collect)) {
      // __yo_gc_collect
      return evaluateYoGcCollect({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.quote)) {
      // metaprogramming
      // quote
      return evaluateQuote({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.gensym)) {
      return evaluateGensym({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_expr_is_atom)) {
      // __yo_expr_is_atom
      return evaluateYoExprIsAtom({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_expr_is_fn_call)
    ) {
      // __yo_expr_is_fn_call
      return evaluateYoExprIsFnCall({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_expr_get_callee)
    ) {
      // __yo_expr_get_callee
      return evaluateYoExprGetCallee({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_expr_get_args)
    ) {
      // __yo_expr_get_args
      return evaluateYoExprGetArgs({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_expr_to_string)
    ) {
      // __yo_expr_to_string
      return evaluateYoExprToString({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_expr_eq)) {
      // __yo_expr_eq
      return evaluateYoExprEq({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_list_car)
    ) {
      // __yo_comptime_list_car
      return evaluateYoComptimeListCar({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_list_cdr)
    ) {
      // __yo_comptime_list_cdr
      return evaluateYoComptimeListCdr({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_list_cons)
    ) {
      // __yo_comptime_list_cons
      return evaluateYoComptimeListCons({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_list_append)
    ) {
      // __yo_comptime_list_append
      return evaluateYoComptimeListAppend({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_list_length)
    ) {
      // __yo_comptime_list_length
      return evaluateYoComptimeListLength({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_comptime_list_element_type
      )
    ) {
      // __yo_comptime_list_element_type
      return evaluateYoComptimeListElementType({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_list_get)
    ) {
      // __yo_comptime_list_get
      return evaluateYoComptimeListGet({
        expr,
        env,
        context: { ...context },
      });
    }
    // All numeric type functions (u8, i8, u16, i16, u32, i32, u64, i64, usize, isize, f32, f64, comptime_int, comptime_float)
    else if (
      exprIsFunctionCall(expr) &&
      expr.func.tag === ExprTag.Atom &&
      typeof expr.func.token.value === "string" &&
      (expr.func.token.value.startsWith("__yo_comptime_u8_") ||
        expr.func.token.value.startsWith("__yo_comptime_i8_") ||
        expr.func.token.value.startsWith("__yo_comptime_u16_") ||
        expr.func.token.value.startsWith("__yo_comptime_i16_") ||
        expr.func.token.value.startsWith("__yo_comptime_u32_") ||
        expr.func.token.value.startsWith("__yo_comptime_i32_") ||
        expr.func.token.value.startsWith("__yo_comptime_u64_") ||
        expr.func.token.value.startsWith("__yo_comptime_i64_") ||
        expr.func.token.value.startsWith("__yo_comptime_usize_") ||
        expr.func.token.value.startsWith("__yo_comptime_isize_") ||
        expr.func.token.value.startsWith("__yo_comptime_f32_") ||
        expr.func.token.value.startsWith("__yo_comptime_f64_") ||
        expr.func.token.value.startsWith("__yo_comptime_int_") ||
        expr.func.token.value.startsWith("__yo_comptime_float_"))
    ) {
      return evaluateYoComptimeNumericFunctions({
        expr: expr as FnCallExpr,
        env,
        context: { ...context },
      });
    }
    // comptime_boolean related functions
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_bool_and, 2) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_bool_or, 2) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_bool_eq, 2) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_bool_neq, 2) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_bool_not, 1) ||
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_comptime_bool_to_comptime_string,
        1
      )
    ) {
      return evaluateYoComptimeBooleanFunctions({
        expr,
        env,
        context: { ...context },
      });
    }
    // comptime_str related functions
    else if (
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_comptime_string_concat,
        2
      ) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_string_eq, 2) ||
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_comptime_string_neq,
        2
      ) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_string_lt, 2) ||
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_comptime_string_lte,
        2
      ) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_string_gt, 2) ||
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_comptime_string_gte,
        2
      ) ||
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_comptime_string_length,
        1
      ) ||
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_comptime_string_to_upper,
        1
      ) ||
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_comptime_string_to_lower,
        1
      ) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_string_slice)
    ) {
      return evaluateYoComptimeStringFunctions({
        expr,
        env,
        context: { ...context },
      });
    }
    // Comptime array/string index builtins
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_array_index) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_string_index) ||
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_comptime_string_index_range
      ) ||
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_comptime_string_index_range_inclusive
      ) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_comptime_list_index) ||
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_comptime_list_index_range
      ) ||
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_comptime_list_index_range_inclusive
      )
    ) {
      return evaluateYoComptimeIndexFunctions({
        expr: expr as FnCallExpr,
        env,
        context: { ...context },
      });
    }
    // Type related functions
    else if (
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_type_to_comptime_string,
        1
      )
    ) {
      // __yo_type_to_comptime_string
      return evaluateYoTypeToString({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_are_types_compatible, 2)
    ) {
      // __yo_are_types_compatible
      return evaluateYoAreTypesCompatible({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_are_types_equal, 2)
    ) {
      // __yo_are_types_equal — exact type match
      return evaluateYoAreTypesEqual({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_type_contains_rc_type, 1)
    ) {
      // __yo_type_contains_rc_type
      return evaluateYoTypeContainsRcType({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_type_can_form_rc_cycle,
        1
      )
    ) {
      // __yo_type_can_form_rc_cycle
      return evaluateYoTypeCanFormRcCycle({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_type_impls, 2)
    ) {
      // __yo_type_impls - check if a type implements a marker module
      return evaluateYoTypeImpls({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_type_get_info, 1)
    ) {
      return evaluateYoTypeGetInfo({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.comptime_eval, 1)) {
      return evaluateComptimeEval({ expr, env, context: { ...context } });
    } else if (
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_comptime_string_to_expr,
        1
      )
    ) {
      return evaluateComptimeStringToExpr({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_type_join_fields, 3)
    ) {
      return evaluateTypeJoinFields({ expr, env, context: { ...context } });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_type_map_variants, 2)
    ) {
      return evaluateTypeMapVariants({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.derive_rule, 2)) {
      return evaluateDeriveRule({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.derive)) {
      // derive(Type, Trait1, Trait2, ...)
      return evaluateDerive({
        expr,
        env,
        context: { ...context },
      });
    }
    // Variable related functions
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_var_print_info, 1)
    ) {
      // __yo_var_print_info
      return evaluateYoVarPrintInfo({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_var_is_owning_the_rc_value
      )
    ) {
      // __yo_var_is_owning_the_rc_value
      return evaluateYoVarIsOwningTheRcValue({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_var_has_other_aliases)
    ) {
      // __yo_var_has_other_aliases
      return evaluateYoVarHasOtherAliases({
        expr,
        env,
        context: { ...context },
      });
    }
    // Process related functions
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_process_platform) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_process_arch) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_pointer_size_bits)
    ) {
      return evaluateYoProcessFunctions({
        expr,
        env,
        context: { ...context },
      });
    }
    // Build system functions
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_executable) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_static_library) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_shared_library) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_test) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_run) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_step) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_step_depend_on) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_target_host) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_target_parse) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_dependency) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_path_dependency) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_system_library) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_link) ||
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_build_link_system_library
      ) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_option) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_dep_artifact) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_module) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_module_link) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_add_import) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_add_cflags) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_dep_module) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_doc)
    ) {
      // Evaluate args before dispatching — builtins expect resolved values
      for (let i = 0; i < expr.args.length; i++) {
        expr.args[i] = _evaluateExpression({
          expr: expr.args[i]!,
          env,
          context: { ...context },
        });
      }
      return evaluateYoBuildFunctions({
        expr,
        env,
        context: { ...context },
      });
    }
    // while loop
    else if (exprIsFunctionCallOf(expr, BuiltinKeywords.while)) {
      // while
      return evaluateWhile({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.va_start)) {
      // va_start
      return evaluateVaStart({ expr, env, context: { ...context } });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_ptr_add) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_ptr_sub) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_ptr_diff)
    ) {
      // Memory safety gate: pointer arithmetic requires `unsafe(...)`.
      // See plans/MEMORY_SAFETY.md. Pointer comparison (`==`, `<`, etc.
      // via the Eq/Ord impls and the __yo_ptr_eq family) stays safe —
      // addresses are just data. Files under std/, yo-self/, tests/, and
      // auto-generated:// are implicitly unsafe-capable (Phase C will
      // replace this with the explicit pragma mechanism).
      //
      // This branch catches DIRECT builtin calls (rare in user code).
      // The `p.add(n)` / `p.sub(n)` / `p.offset_from(q)` METHOD calls
      // (plans/archive/POINTER_OPERATORS_TO_TRAITS_AND_METHODS.md — formerly the
      // `&+`/`&-`/`&/` operators) are gated at method resolution
      // (calls/function.ts), where the receiver type is known; the
      // builtin call inside the prelude impl body is implicitly
      // unsafe-capable by path, so it cannot fire here on the user's
      // behalf.
      if (
        !context.unsafeContext &&
        !isImplicitlyUnsafeCapableFile(expr.token.modulePath)
      ) {
        const fnName = exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_ptr_add)
          ? "__yo_ptr_add"
          : exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_ptr_sub)
            ? "__yo_ptr_sub"
            : "__yo_ptr_diff";
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Pointer arithmetic ('${fnName}') requires 'unsafe(...)'.

Wrap the expression as: unsafe(${exprToString(expr)})

Raw pointer arithmetic produces addresses usually destined to dereference, which may access invalid memory.`,
        });
      }
      // Permitted under unsafe(...) or in unsafe-capable file; fall
      // through to normal call eval.
      return evaluateFunctionCall({
        expr,
        env,
        context: { ...context },
      });
    } else {
      /*
      else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Exists)) {
        // exists
        return this.evaluateExists({ expr, env, context: { ...context } });
      }
      */
      /* else if (exprIsFunctionCallOf(expr, ".", 1)) {
        // variant
        return this.evaluateVariant({ expr, env, context });
      }
      */
      // Function call
      return evaluateFunctionCall({
        expr,
        env,
        context: { ...context },
      });
    }
  }
}
