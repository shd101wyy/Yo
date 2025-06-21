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
  exprToString,
} from "../expr";
import Parser from "../parser";
import { Token, TokenType } from "../token";
import { ModuleValue } from "../value";

// Import extracted evaluator functions
import { evaluateAndOr } from "./builtins/and_or";
import { evaluateComptAssert } from "./builtins/compt_assert";
import { evaluateComptExpectError } from "./builtins/compt_expect_error";
import { evaluateYoComptIntArithmetic } from "./builtins/compt_int_fns";
import { evaluateDrop } from "./builtins/drop";
import {
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
import { evaluateNot } from "./builtins/not";
import { evaluateQuote } from "./builtins/quote";
import {
  evaluateYoAreTypesCompatible,
  evaluateYoTypeToString,
} from "./builtins/type_fns";
import { evaluateFunctionCall } from "./calls/function";
import { evaluateRawPointerCall } from "./calls/pointer";
import { evaluateReferenceCall } from "./calls/reference";
import { EvaluatorContext } from "./context";
import { evaluateAssignment } from "./exprs/assignment";
import { evaluateBeginExpression } from "./exprs/begin";
import { evaluateBinding } from "./exprs/binding";
import { evaluateBorrow } from "./exprs/borrow";
import { evaluateCond } from "./exprs/cond";
import { evaluateExtern } from "./exprs/extern";
import { evaluateIdentifierAndOperator } from "./exprs/identifer_and_operator";
import { evaluateImport } from "./exprs/import";
import { evaluateInitializationAssignment } from "./exprs/initialization_assignment";
import { evaluateMatch } from "./exprs/match";
import { evaluateModule } from "./exprs/module";
import { evaluateOpen } from "./exprs/open";
import { evaluatePropertyAccess } from "./exprs/property_access";
import { evaluateRecur } from "./exprs/recur";
import { evaluateTypeOf } from "./exprs/typeof";
import { evaluateArrayType } from "./types/array";
import { evaluateEnumType } from "./types/enum";
import { evaluateFunctionType } from "./types/function";
import { evaluateStructType } from "./types/struct";
import { evaluateTupleType } from "./types/tuple";
import { evaluateUnionType } from "./types/union";
import { evaluateAnonymousFunctionImplementation } from "./values/anonymous_function";
import { evaluateAnonymousModuleBeginExprs } from "./values/anonymous_module";
import { evaluateArrayValue } from "./values/array";
import { evaluateBooleanLiteral } from "./values/boolean";
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
        // Function implementation
        if (
          // (fn(x) -> x)
          exprIsFunctionCall(expr.args[0]) &&
          exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.fn)
        ) {
          return evaluateAnonymousFunctionImplementation({
            expr,
            env,
            context: { ...context },
          });
        }

        // Function type
        return evaluateFunctionType({
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
        return evaluateStructType({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.enum)) {
        // enum
        return evaluateEnumType({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.union)) {
        // union
        return evaluateUnionType({ expr, env, context: { ...context } });
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
        });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.module)) {
        // module
        return evaluateModule({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinFunctions.typeof)) {
        // typeof
        return evaluateTypeOf({ expr, env, context: { ...context } });
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
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.not, 1)) {
        // not
        return evaluateNot({ expr, env, context: { ...context } });
      } else if (
        exprIsFunctionCallOf(expr, BuiltinKeywords.and) ||
        exprIsFunctionCallOf(expr, BuiltinKeywords.or)
      ) {
        // and/or
        return evaluateAndOr({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.drop, 1)) {
        // drop
        return evaluateDrop({ expr, env, context: { ...context } });
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.quote, 1)) {
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
      // compt_int related arithmetic functions
      else if (
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_add, 2) ||
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_sub, 2) ||
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_mul, 2) ||
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_div, 2) ||
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_mod, 2) ||
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_neg, 1) ||
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_eq, 2) ||
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_neq, 2) ||
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_lt, 2) ||
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_lte, 2) ||
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_gt, 2) ||
        exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_compt_int_gte, 2)
      ) {
        return evaluateYoComptIntArithmetic({
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
      } else {
        /* else if (exprIsFunctionCallOf(expr, BuiltinKeywords.while)) {
        // while
        return this.evaluateWhile({ expr, env, context: { ...context } });
      }
      */
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
