import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { TokenType } from "../../token";
import { evaluateAlignOf } from "../builtins/alignof";
import { evaluateAndOr } from "../builtins/and_or";
import {
  evaluateIsUniquelyOwned,
  evaluateYoDecrRc,
  evaluateYoDynVtableDrop,
  evaluateYoDynVtableDup,
  evaluateYoIncrRc,
  evaluateYoRcOwn,
  evaluateYoSomeTypeDrop,
  evaluateYoSomeTypeDup,
} from "../builtins/arc_fns";
import { evaluateComptAssert } from "../builtins/compt_assert";
import { evaluateYoComptBooleanFunctions } from "../builtins/compt_boolean_fns";
import { evaluateComptExpectError } from "../builtins/compt_expect_error";
import {
  evaluateYoComptListAppend,
  evaluateYoComptListCar,
  evaluateYoComptListCdr,
  evaluateYoComptListCons,
  evaluateYoComptListElementType,
  evaluateYoComptListLength,
} from "../builtins/compt_list_fns";
import { evaluateComptPrint } from "../builtins/compt_print";
import { evaluateYoComptStringFunctions } from "../builtins/compt_string_fns";
import {
  evaluateAsync,
  evaluateTaskSetMaximumThreads,
} from "../builtins/concurrency_fns";
import { evaluateConsume } from "../builtins/consume";
import { evaluateDrop } from "../builtins/drop";
import { evaluateDup } from "../builtins/dup";
import {
  evaluateYoExprEq,
  evaluateYoExprGetArgs,
  evaluateYoExprGetCallee,
  evaluateYoExprIsAtom,
  evaluateYoExprIsFnCall,
  evaluateYoExprToString,
} from "../builtins/expr_fns";
import { evaluateAwait } from "../builtins/future_fns";
import { evaluateYoGcCollect } from "../builtins/gc";
import { evaluateGensym } from "../builtins/gensym";
import { evaluateImplConstraint } from "../builtins/impl_constraint";
import { evaluateMacroExpand } from "../builtins/macro_expand";
import { evaluateYoNumericFunctions } from "../builtins/numeric_fns";
import { evaluatePanic } from "../builtins/panic";
import { evaluateAddressCall } from "../builtins/ptr_fns";
import { evaluateQuote } from "../builtins/quote";
import { evaluateSizeOf } from "../builtins/sizeof";
import { evaluateThe } from "../builtins/the";
import {
  evaluateYoAreTypesCompatible,
  evaluateYoTypeContainsArcType,
  evaluateYoTypeImpls,
  evaluateYoTypeToString,
} from "../builtins/type_fns";
import { evaluateVaStart } from "../builtins/va_start";
import { evaluateFunctionCall } from "../calls/function";
import { evaluateRawPointerCall } from "../calls/pointer";
import { EvaluatorContext } from "../context";
import { evaluateArrayType } from "../types/array";
import { evaluateClosureType } from "../types/closure";
import { evaluateComptListType } from "../types/compt_list";
import { evaluateDynType } from "../types/dyn";
import { evaluateEnumType } from "../types/enum";
import { evaluateFnModuleType } from "../types/fn_module";
import { evaluateFunctionType } from "../types/function";
import { evaluateFutureType } from "../types/future_module";
import { evaluateModuleType } from "../types/module";
import { evaluateNewtypeType } from "../types/newtype";
import { evaluateObjectType } from "../types/object";
import { evaluateSliceType } from "../types/slice";
import { evaluateStructType } from "../types/struct";
import { evaluateTupleType } from "../types/tuple";
import { evaluateUnionType } from "../types/union";
import { evaluateAnonymousFunctionImplementation } from "../values/anonymous_function";
import { evaluateArrayValue } from "../values/array";
import { evaluateBooleanLiteral } from "../values/boolean";
import { evaluateCharLiteral } from "../values/char";
import { evaluateComptListValue } from "../values/compt_list";
import { evaluateDynValue } from "../values/dyn";
import { evaluateFloatLiteral } from "../values/float";
import { evaluateIntegerLiteral } from "../values/integer";
import { evaluateModuleValue } from "../values/module";
import { evaluateStringLiteral } from "../values/string";
import { evaluateTupleValue } from "../values/tuple";
import { evaluateAssignment } from "./assignment";
import { evaluateBeginExpression } from "./begin";
import { evaluateBinding } from "./binding";
import { evaluateCInclude } from "./c_include";
import { evaluateCond } from "./cond";
import { evaluateExtern } from "./extern";
import { evaluateIdentifierAndOperator } from "./identifer_and_operator";
import { evaluateImport } from "./import";
import { evaluateInitializationAssignment } from "./initialization_assignment";
import { evaluateMatch } from "./match";
import { evaluateOpen } from "./open";
import { evaluatePropertyAccess } from "./property_access";
import { evaluateRecur } from "./recur";
import { evaluateSubtypeOf } from "./subtype_of";
import { evaluateTest } from "./test";
import { evaluateTypeOf } from "./typeof";
import { evaluateWhile } from "./while";

export function _evaluateExpression({
  expr,
  env,
  context,
}: {
  expr: Expr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  if (exprIsAtom(expr)) {
    switch (expr.token.type) {
      case TokenType.Identifier:
      case TokenType.Operator:
      case TokenType.BacktickIdentifier: {
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
      case TokenType.Boolean: {
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
        // (fn(x : i32) -> i32)
        exprIsFunctionCall(expr.args[0]) &&
        (exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.fn) ||
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
          },
        });
      }

      // Fn module type (trait for callable types)
      // Fn(x : i32) -> i32
      if (
        exprIsFunctionCall(expr.args[0]) &&
        exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.Fn)
      ) {
        return evaluateFnModuleType({
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
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.compt_list)) {
      // compt_list
      return evaluateComptListValue({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.dyn)) {
      // dyn
      return evaluateDynValue({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.struct)) {
      // struct
      return evaluateStructType({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.object)) {
      // object (reference semantics struct)
      return evaluateObjectType({
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
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.module)) {
      // module type
      return evaluateModuleType({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Impl)) {
      // Impl constraint type
      return evaluateImplConstraint({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.impl)) {
      // module value implementation
      return evaluateModuleValue({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.typeof)) {
      // typeof
      return evaluateTypeOf({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.sizeof)) {
      // sizeof
      return evaluateSizeOf({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.alignof)) {
      // alignof
      return evaluateAlignOf({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, "<:")) {
      // <: subtype_of
      return evaluateSubtypeOf({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.the)) {
      // the
      return evaluateThe({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.async)) {
      // async
      return evaluateAsync({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.await)) {
      // await
      return evaluateAwait({ expr, env, context: { ...context } });
    } else if (
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_concurrency_set_maximum_threads
      )
    ) {
      // __yo_concurrency_set_maximum_threads
      return evaluateTaskSetMaximumThreads({
        expr,
        env,
        context: { ...context },
      });
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
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Slice)) {
      // Slice type
      return evaluateSliceType({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.ComptList)) {
      // ComptList type
      return evaluateComptListType({
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
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Dyn)) {
      // Dyn type
      return evaluateDynType({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.compt_expect_error)
    ) {
      // compt_expect_error
      return evaluateComptExpectError({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.compt_assert)) {
      // compt_assert
      return evaluateComptAssert({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.compt_print)) {
      // compt_print
      return evaluateComptPrint({
        expr,
        env,
        context: { ...context },
      });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.panic)) {
      // panic
      return evaluatePanic({
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
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.consume)) {
      // consume
      return evaluateConsume({
        expr,
        env,
        context: { ...context },
      });
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
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_rc_own)) {
      // __yo_rc_own
      return evaluateYoRcOwn({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.is_uniquely_owned)) {
      // is_uniquely_owned
      return evaluateIsUniquelyOwned({ expr, env, context: { ...context } });
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
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_list_car)
    ) {
      // __yo_compt_list_car
      return evaluateYoComptListCar({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_list_cdr)
    ) {
      // __yo_compt_list_cdr
      return evaluateYoComptListCdr({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_list_cons)
    ) {
      // __yo_compt_list_cons
      return evaluateYoComptListCons({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_list_append)
    ) {
      // __yo_compt_list_append
      return evaluateYoComptListAppend({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_list_length)
    ) {
      // __yo_compt_list_length
      return evaluateYoComptListLength({
        expr,
        env,
        context: { ...context },
      });
    } else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_list_element_type)
    ) {
      // __yo_compt_list_element_type
      return evaluateYoComptListElementType({
        expr,
        env,
        context: { ...context },
      });
    }
    // All numeric type functions (u8, i8, u16, i16, u32, i32, u64, i64, usize, isize, f32, f64, compt_int, compt_float)
    else if (
      exprIsFunctionCall(expr) &&
      expr.func.tag === ExprTag.Atom &&
      typeof expr.func.token.value === "string" &&
      (expr.func.token.value.startsWith("__yo_u8_") ||
        expr.func.token.value.startsWith("__yo_i8_") ||
        expr.func.token.value.startsWith("__yo_u16_") ||
        expr.func.token.value.startsWith("__yo_i16_") ||
        expr.func.token.value.startsWith("__yo_u32_") ||
        expr.func.token.value.startsWith("__yo_i32_") ||
        expr.func.token.value.startsWith("__yo_u64_") ||
        expr.func.token.value.startsWith("__yo_i64_") ||
        expr.func.token.value.startsWith("__yo_usize_") ||
        expr.func.token.value.startsWith("__yo_isize_") ||
        expr.func.token.value.startsWith("__yo_f32_") ||
        expr.func.token.value.startsWith("__yo_f64_") ||
        expr.func.token.value.startsWith("__yo_compt_int_") ||
        expr.func.token.value.startsWith("__yo_compt_float_") ||
        // C compatible types
        expr.func.token.value.startsWith("__yo_char") ||
        expr.func.token.value.startsWith("__yo_short_") ||
        expr.func.token.value.startsWith("__yo_ushort_") ||
        expr.func.token.value.startsWith("__yo_int_") ||
        expr.func.token.value.startsWith("__yo_uint_") ||
        expr.func.token.value.startsWith("__yo_long_") ||
        expr.func.token.value.startsWith("__yo_ulong_") ||
        expr.func.token.value.startsWith("__yo_longlong_") ||
        expr.func.token.value.startsWith("__yo_ulonglong_") ||
        expr.func.token.value.startsWith("__yo_longdouble_"))
    ) {
      return evaluateYoNumericFunctions({
        expr: expr as FuncCallExpr,
        env,
        context: { ...context },
      });
    }
    // compt_boolean related functions
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_boolean_and, 2) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_boolean_or, 2) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_boolean_eq, 2) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_boolean_neq, 2) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_boolean_not, 1) ||
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_compt_boolean_to_string,
        1
      )
    ) {
      return evaluateYoComptBooleanFunctions({
        expr,
        env,
        context: { ...context },
      });
    }
    // compt_string related functions
    else if (
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_compt_string_concat,
        2
      ) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_string_eq, 2) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_string_neq, 2) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_string_lt, 2) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_string_lte, 2) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_string_gt, 2) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_string_gte, 2) ||
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_compt_string_length,
        1
      ) ||
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_compt_string_to_upper,
        1
      ) ||
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_compt_string_to_lower,
        1
      ) ||
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_string_slice)
    ) {
      return evaluateYoComptStringFunctions({
        expr,
        env,
        context: { ...context },
      });
    }
    // Type related functions
    else if (
      exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_type_to_string, 1)
    ) {
      // __yo_type_to_string
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
      exprIsFunctionCallOf(
        expr,
        BuiltinFunctions.__yo_type_contains_arc_type,
        1
      )
    ) {
      // __yo_type_contains_arc_type
      return evaluateYoTypeContainsArcType({
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
    }
    // while loop
    else if (exprIsFunctionCallOf(expr, BuiltinKeywords.while)) {
      // while
      return evaluateWhile({ expr, env, context: { ...context } });
    } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.va_start)) {
      // va_start
      return evaluateVaStart({ expr, env, context: { ...context } });
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
