import { readFileSync } from "node:fs";
import { createNewEnv, Environment } from "../env";
import { formatErrorMessage } from "../error";
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
} from "../expr";
import Parser from "../parser";
import { Token, TokenType } from "../token";
import { ModuleValue } from "../value";

// Import extracted evaluator functions
import { evaluateAlignOf } from "./builtins/alignof";
import { evaluateAndOr } from "./builtins/and_or";
import { evaluateComptAssert } from "./builtins/compt_assert";
import { evaluateYoComptBooleanFunctions } from "./builtins/compt_boolean_fns";
import { evaluateComptExpectError } from "./builtins/compt_expect_error";
import { evaluateComptPrint } from "./builtins/compt_print";
import { evaluateYoComptStringFunctions } from "./builtins/compt_string_fns";
import { evaluateDoExpression } from "./builtins/do";
import { evaluateDrop } from "./builtins/drop";
import {
  evaluateYoExprEq,
  evaluateYoExprGetArgs,
  evaluateYoExprGetCallee,
  evaluateYoExprIsAtom,
  evaluateYoExprIsFnCall,
  evaluateYoExprToString,
} from "./builtins/expr_fns";
import {
  evaluateYoExprListAppend,
  evaluateYoExprListCar,
  evaluateYoExprListCdr,
  evaluateYoExprListCons,
  evaluateYoExprListLength,
} from "./builtins/expr_list_fns";
import { evaluateGensym } from "./builtins/gensym";
import { evaluateMacroExpand } from "./builtins/macro_expand";
import { evaluateYoNumericFunctions } from "./builtins/numeric_fns";
import { evaluateQuote } from "./builtins/quote";
import { evaluateSizeOf } from "./builtins/sizeof";
import { evaluateThe } from "./builtins/the";
import {
  evaluateYoAreTypesCompatible,
  evaluateYoTypeContainsReference,
  evaluateYoTypeIsFree,
  evaluateYoTypeIsLinear,
  evaluateYoTypeToString,
} from "./builtins/type_fns";
import { evaluateVaStart } from "./builtins/va_start";
import { evaluateFunctionCall } from "./calls/function";
import { evaluateRawPointerCall } from "./calls/pointer";
import { evaluateReferenceCall } from "./calls/reference";
import { EvaluatorContext } from "./context";
import { evaluateAssignment } from "./exprs/assignment";
import { evaluateBeginExpression } from "./exprs/begin";
import { evaluateBinding } from "./exprs/binding";
import { evaluateBorrow } from "./exprs/borrow";
import { evaluateCInclude } from "./exprs/c_include";
import { evaluateCond } from "./exprs/cond";
import { evaluateConsume } from "./exprs/consume";
import { evaluateExtern } from "./exprs/extern";
import { evaluateFor } from "./exprs/for";
import { evaluateIdentifierAndOperator } from "./exprs/identifer_and_operator";
import { evaluateImport } from "./exprs/import";
import { evaluateInitializationAssignment } from "./exprs/initialization_assignment";
import { evaluateMatch } from "./exprs/match";
import { evaluateModule } from "./exprs/module";
import { evaluateOpen } from "./exprs/open";
import { evaluatePropertyAccess } from "./exprs/property_access";
import { evaluateRecur } from "./exprs/recur";
import { evaluateTypeOf } from "./exprs/typeof";
import { evaluateWhile } from "./exprs/while";
import { evaluateArrayType } from "./types/array";
import { evaluateClosureType } from "./types/closure";
import { evaluateEffType } from "./types/eff";
import { evaluateEnumType } from "./types/enum";
import { evaluateFunctionType } from "./types/function";
import { evaluateSliceType } from "./types/slice";
import { evaluateStructType } from "./types/struct";
import { evaluateTupleType } from "./types/tuple";
import { evaluateUnionType } from "./types/union";
import { evaluateAnonymousFunctionImplementation } from "./values/anonymous_function";
import { evaluateAnonymousModuleBeginExprs } from "./values/anonymous_module";
import { evaluateArrayValue } from "./values/array";
import { evaluateBooleanLiteral } from "./values/boolean";
import { evaluateCharLiteral } from "./values/char";
import { evaluateExprListValue } from "./values/expr_list";
import { evaluateFloatLiteral } from "./values/float";
import { evaluateIntegerLiteral } from "./values/integer";
import { evaluateStringLiteral } from "./values/string";
import { evaluateTupleValue } from "./values/tuple";

/**
 * This class is responsible for:
 * - Type checking the program
 * - Compile-time evaluation
 */
export default class Evaluator {
  private inputString: string;
  private modulePath: string;
  private stdPath: string;
  private parser: Parser;
  private program: Expr[];
  private tokens: Token[];
  private moduleValue: ModuleValue;
  private moduleError: Error | undefined;
  private loadModule: (modulePath: string) => {
    moduleValue: ModuleValue;
    moduleError: Error | undefined;
  };

  constructor({
    modulePath,
    stdPath,
    loadModule,
  }: {
    modulePath: string;
    stdPath: string;
    loadModule: (modulePath: string) => {
      moduleValue: ModuleValue;
      moduleError: Error | undefined;
    };
  }) {
    this.modulePath = modulePath;
    this.stdPath = stdPath;
    this.loadModule = loadModule;

    if (!this.modulePath.match(/^file:\/\//)) {
      throw new Error(
        `Invalid file protocol: ${this.modulePath}. Only file:// is supported for now.  `
      );
    }
    try {
      this.inputString = readFileSync(
        modulePath.replace(/^file:\/\//, ""), // NOTE: We only support local file for now
        "utf-8"
      );

      // Parse the module
      this.parser = new Parser({ modulePath, inputString: this.inputString });
      this.program = this.parser.getProgram();
      this.tokens = this.parser.getTokens();

      // Evaluate the program
      this.evaluateProgram();
    } catch (error) {
      throw new Error(
        `Failed to import module "${modulePath}":\n${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Add a public method to get the program
  public getProgram(): Expr[] {
    return this.program;
  }

  // Add a public method to get the tokens
  public getTokens(): Token[] {
    return this.tokens;
  }

  private evaluateExpression({
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
          return evaluateIntegerLiteral(expr, env);
        }
        case TokenType.Float: {
          return evaluateFloatLiteral(expr, env);
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
            errorMessage: `(1) Evaluating the expression below is not implemented:
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
          // (eff(x : i32) -> i32)
          exprIsFunctionCall(expr.args[0]) &&
          (exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.fn) ||
            exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.eff))
        ) {
          return evaluateFunctionType({
            expr,
            env,
            context: { ...context },
          });
        }

        // Check if left side is FnMove, Fn, or FnMut
        const leftSide = expr.args[0]!;
        if (exprIsFunctionCall(leftSide)) {
          if (exprIsFunctionCallOf(leftSide, BuiltinKeywords.FnMove)) {
            // FnMove(paramType) -> returnType - closure that can be called once
            // Check if we're in a closure context
            if (!context.isEvaluatingClosureCallType) {
              throw formatErrorMessage({
                token: leftSide.token,
                errorMessage: `FnMove can only be used as the call type within a Closure type.
Use: Closure(FnMove(elem: Type) -> ReturnType, CaptureType)
Instead of: FnMove(elem: Type) -> ReturnType`,
              });
            }
            return evaluateFunctionType({
              expr,
              env,
              context: { ...context },
              closureKind: "FnMove",
            });
          } else if (exprIsFunctionCallOf(leftSide, BuiltinKeywords.Fn)) {
            // Fn(paramType) -> returnType - closure that can be called multiple times
            // Check if we're in a closure context
            if (!context.isEvaluatingClosureCallType) {
              throw formatErrorMessage({
                token: leftSide.token,
                errorMessage: `Fn can only be used as the call type within a Closure type.
Use: Closure(Fn(elem: Type) -> ReturnType, CaptureType)
Instead of: Fn(elem: Type) -> ReturnType`,
              });
            }
            return evaluateFunctionType({
              expr,
              env,
              context: { ...context },
              closureKind: "Fn",
            });
          } else if (exprIsFunctionCallOf(leftSide, BuiltinKeywords.FnMut)) {
            // FnMut(paramType) -> returnType - closure that can be called multiple times with mutation
            // Check if we're in a closure context
            if (!context.isEvaluatingClosureCallType) {
              throw formatErrorMessage({
                token: leftSide.token,
                errorMessage: `FnMut can only be used as the call type within a Closure type.
Use: Closure(FnMut(elem: Type) -> ReturnType, CaptureType)
Instead of: FnMut(elem: Type) -> ReturnType`,
              });
            }
            return evaluateFunctionType({
              expr,
              env,
              context: { ...context },
              closureKind: "FnMut",
            });
          }
        }

        // Anonymous function implementation
        // (x) -> x;
        return evaluateAnonymousFunctionImplementation({
          expr,
          env,
          context: { ...context },
        });
      } else if (exprIsFunctionCallOf(expr, "=>", 2)) {
        // Closure type
        // fn(x : i32) => i32;
        if (
          exprIsFunctionCall(expr.args[0]) &&
          exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.fn)
        ) {
          // Convert it to `Closure(FnMove(x : i32) -> i32, _)`
          const newExpr: FuncCallExpr = {
            tag: ExprTag.FuncCall,
            func: {
              tag: ExprTag.Atom,
              token: {
                ...expr.token,
                type: TokenType.Identifier,
                value: BuiltinKeywords.Closure[0]!,
              },
            },
            args: [
              {
                tag: ExprTag.FuncCall,
                func: {
                  tag: ExprTag.Atom,
                  token: {
                    ...expr.token,
                    type: TokenType.Operator,
                    value: "->",
                  },
                },
                token: {
                  ...expr.token,
                  type: TokenType.Operator,
                  value: "->",
                },
                args: [
                  {
                    tag: ExprTag.FuncCall,
                    func: {
                      tag: ExprTag.Atom,
                      token: {
                        ...expr.args[0]!.token,
                        type: TokenType.Identifier,
                        value: BuiltinKeywords.FnMove[0]!,
                      },
                    },
                    args: expr.args[0]!.args, // Function parameters
                    token: expr.args[0]!.token,
                  },
                  expr.args[1]!, // Return type
                ],
                isInfix: true,
              },
              {
                tag: ExprTag.Atom,
                token: {
                  ...expr.token,
                  type: TokenType.Identifier,
                  value: "_",
                },
              }, // Capture type is underscore
            ],
            token: expr.token,
          };

          return evaluateClosureType({
            expr: newExpr,
            env,
            context: { ...context },
          });
        }

        // FnMove closue
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
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.expr_list)) {
        // expr_list
        return evaluateExprListValue({
          expr,
          env,
          context: { ...context },
        });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.struct)) {
        // struct
        return evaluateStructType({
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
        // module
        return evaluateModule({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.typeof)) {
        // typeof
        return evaluateTypeOf({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.sizeof)) {
        // sizeof
        return evaluateSizeOf({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.alignof)) {
        // alignof
        return evaluateAlignOf({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.the)) {
        // the
        return evaluateThe({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.do)) {
        // do
        return evaluateDoExpression({
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
          stdPath: this.stdPath,
        });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.open)) {
        // open
        return evaluateOpen({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.borrow)) {
        // borrow
        return evaluateBorrow({ expr, env, context: { ...context } });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinKeywords.Ptr, 1) ||
        exprIsFunctionCallOf(expr, BuiltinKeywords.MutPtr, 1)
      ) {
        // * or *! raw pointers
        return evaluateRawPointerCall({
          expr,
          env,
          context: { ...context },
        });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinKeywords.MutRef, 1) ||
        exprIsFunctionCallOf(expr, BuiltinKeywords.Ref, 1)
      ) {
        // & or &! references
        return evaluateReferenceCall({
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
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.Closure)) {
        // Closure type
        return evaluateClosureType({
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
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.__YoEff)) {
        // Eff type
        return evaluateEffType({
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
      } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.macro_expand)) {
        // macro_expand
        return evaluateMacroExpand({
          expr,
          env,
          context: { ...context },
        });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinKeywords.and) ||
        exprIsFunctionCallOf(expr, BuiltinKeywords.or)
      ) {
        // and/or
        return evaluateAndOr({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.consume)) {
        // consume
        return evaluateConsume({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.drop)) {
        // drop
        return evaluateDrop({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.quote)) {
        // metaprogramming
        // quote
        return evaluateQuote({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.gensym)) {
        return evaluateGensym({ expr, env, context: { ...context } });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_expr_is_atom)
      ) {
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
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_expr_list_car)
      ) {
        // __yo_expr_list_car
        return evaluateYoExprListCar({
          expr,
          env,
          context: { ...context },
        });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_expr_list_cdr)
      ) {
        // __yo_expr_list_cdr
        return evaluateYoExprListCdr({
          expr,
          env,
          context: { ...context },
        });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_expr_list_cons)
      ) {
        // __yo_expr_list_cons
        return evaluateYoExprListCons({
          expr,
          env,
          context: { ...context },
        });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_expr_list_append)
      ) {
        // __yo_expr_list_append
        return evaluateYoExprListAppend({
          expr,
          env,
          context: { ...context },
        });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_expr_list_length)
      ) {
        // __yo_expr_list_length
        return evaluateYoExprListLength({
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
        exprIsFunctionCallOf(
          expr,
          BuiltinFunctions.__yo_compt_boolean_and,
          2
        ) ||
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_boolean_or, 2) ||
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_boolean_eq, 2) ||
        exprIsFunctionCallOf(
          expr,
          BuiltinFunctions.__yo_compt_boolean_neq,
          2
        ) ||
        exprIsFunctionCallOf(
          expr,
          BuiltinFunctions.__yo_compt_boolean_not,
          1
        ) ||
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
        exprIsFunctionCallOf(
          expr,
          BuiltinFunctions.__yo_are_types_compatible,
          2
        )
      ) {
        // __yo_are_types_compatible
        return evaluateYoAreTypesCompatible({
          expr,
          env,
          context: { ...context },
        });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_type_is_free, 1)
      ) {
        // __yo_type_if_free;
        return evaluateYoTypeIsFree({
          expr,
          env,
          context: { ...context },
        });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_type_is_linear, 1)
      ) {
        // __yo_type_is_linear;
        return evaluateYoTypeIsLinear({
          expr,
          env,
          context: { ...context },
        });
      } else if (
        exprIsFunctionCallOf(
          expr,
          BuiltinFunctions.__yo_type_contains_reference,
          1
        )
      ) {
        // __yo_type_contains_reference;
        return evaluateYoTypeContainsReference({
          expr,
          env,
          context: { ...context },
        });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.while)) {
        // while
        return evaluateWhile({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.for)) {
        // for
        return evaluateFor({ expr, env, context: { ...context } });
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

  private evaluateProgram(): void {
    let env = createNewEnv({
      modulePath: this.modulePath,
      inputString: this.inputString,
    });

    const {
      moduleValue,
      env: nextEnv,
      partialModuleError,
    } = evaluateAnonymousModuleBeginExprs({
      beginExprs: this.program,
      env,
      context: {
        isExecuting: true, // We're executing the main program
        expectedType: undefined,
        SelfType: undefined,
        borrowings: [],
        evaluateExpression: this.evaluateExpression.bind(this),
        loadModule: this.loadModule.bind(this),
      },
      allowPartialModule: true,
    });
    env = nextEnv;
    this.moduleValue = moduleValue;
    this.moduleError = partialModuleError;
  }

  public getModuleValue(): ModuleValue {
    if (!this.moduleValue) {
      throw new Error("Module value is not set");
    }
    return this.moduleValue;
  }

  public getModuleError(): Error | undefined {
    return this.parser.getParserError() ?? this.moduleError;
  }
}
