import { Environment } from "../env";
import {
  BuiltinKeywords,
  Expr,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
  setExprAsConsumed,
} from "../expr";
import { Token } from "../token";
import {
  areTypesCompatible,
  convertComptTypeToRuntimeType,
  createArrayType,
  isExprType,
  Type,
  typeToString,
} from "../type-value";
import {
  createArrayValue,
  createExprListValue,
  createNumberValue,
  ExprValue,
  isExprValue,
  isUnknownValue,
  UnknownValue,
  Value,
  valueToString,
  VUnit,
} from "../value";
import { ValueTag } from "../value-tag";

// Interface for evaluator context - simplified for now
interface EvaluatorContext {
  borrowings: any[];
  expectedType?: any;
  isEvaluatingFunctionBody?: any;
  SelfType?: any;
  ModuleType?: any;
}

/**
 * Evaluates tuple value expressions
 */
export function evaluateTupleValue(
  expr: FuncCallExpr,
  env: Environment,
  context: EvaluatorContext,
  formatErrorMessage: (token: Token, message: string) => Error,
  evaluateTupleElementsValue: (params: {
    args: Expr[];
    env: Environment;
    context: EvaluatorContext;
  }) => any
): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.tuple)) {
    throw formatErrorMessage(expr.token, `Expected tuple, got ${expr.tag}`);
  }

  if (expr.args.length === 0) {
    // Unit
    expr.$ = {
      env,
      value: VUnit,
      type: VUnit.type,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }

  const {
    type: tupleType,
    value: tupleValue,
    env: nextEnv,
  } = evaluateTupleElementsValue({ args: expr.args, env, context });
  env = nextEnv;

  // We disallow the tuple elements to have defaultValue for the tuple type
  // We disallow the tuple value to have labels. Only the tuple type can have labels.
  tupleType.elements.forEach((tupleElement: any) => {
    if (tupleElement.exprs.defaultValueExpr) {
      throw formatErrorMessage(
        tupleElement.exprs.defaultValueExpr!.token,
        `Tuple type cannot have default value.`
      );
    }

    if (tupleElement.exprs.labelExpr) {
      throw formatErrorMessage(
        tupleElement.exprs.labelExpr!.token,
        `Tuple value cannot have labels.`
      );
    }
  });

  expr.$ = {
    env,
    value: tupleValue,
    type: tupleType,
    isMutable: true,
    pathCollection: [],
  };
  return expr;
}

/**
 * Evaluates array value expressions
 */
export function evaluateArrayValue(
  expr: FuncCallExpr,
  env: Environment,
  context: EvaluatorContext,
  formatErrorMessage: (token: Token, message: string) => Error,
  evaluateExpression: (params: {
    expr: Expr;
    env: Environment;
    context: EvaluatorContext;
  }) => Expr
): FuncCallExpr {
  const arrayElementExprs = expr.args;

  // NOTE: We disallow the empty array for now.
  if (arrayElementExprs.length === 0) {
    throw formatErrorMessage(
      expr.token,
      `Expected at least one element in array, got ${arrayElementExprs.length}`
    );
  }

  const arrayLength = arrayElementExprs.length;
  let arrayElementType: Type | undefined = undefined;
  const arrayElementValues: (Value | undefined)[] = [];
  for (let i = 0; i < arrayElementExprs.length; i++) {
    const arrayElementExpr = arrayElementExprs[i]!;
    const evaluatedElement = evaluateExpression({
      expr: arrayElementExpr,
      env,
      context: {
        ...context,
      },
    });

    if (!evaluatedElement.$) {
      throw formatErrorMessage(
        arrayElementExpr.token,
        `Failed to evaluate array element: ${exprToString(arrayElementExpr)}`
      );
    }
    env = evaluatedElement.$.env;

    // Set the evaluatedElement as consumed
    env = setExprAsConsumed(evaluatedElement, env);

    // Save value
    arrayElementValues.push(evaluatedElement.$.value);

    // Check type
    if (!arrayElementType) {
      arrayElementType = evaluatedElement.$.type;
    } else {
      // Check if the type of the element matches the first element type
      if (
        !areTypesCompatible(
          { type: arrayElementType, env },
          { type: evaluatedElement.$.type, env }
        )
      ) {
        // Check if types match when converting to runtime type.
        // For example:
        //    x := 12; // x: i32
        //    arr := [1, x, 3];
        //    -  1: compt_int
        //    -  x: i32
        //    Here we convert compt_int to i32 to check compatibility.
        if (
          areTypesCompatible(
            {
              type: convertComptTypeToRuntimeType(arrayElementType),
              env,
            },
            {
              type: evaluatedElement.$.type,
              env,
            }
          )
        ) {
          arrayElementType = evaluatedElement.$.type;
        } else {
          throw formatErrorMessage(
            arrayElementExpr.token,
            `Array element type mismatch:
Expected type: ${typeToString(arrayElementType)}
Given type: ${typeToString(evaluatedElement.$.type)}`
          );
        }
      }
    }
  }

  const arrayType = createArrayType(
    arrayElementType!,
    createNumberValue(ValueTag.Usize, arrayLength)
  );

  const arrayValue = arrayElementValues.every((val) => !!val)
    ? createArrayValue(arrayType, arrayElementValues as Value[])
    : undefined;

  expr.$ = {
    env,
    type: arrayType,
    value: arrayValue,
    isMutable: true,
    pathCollection: [],
  };
  return expr;
}

/**
 * Evaluates expression list values
 */
export function evaluateExprListValue(
  expr: FuncCallExpr,
  env: Environment,
  context: EvaluatorContext,
  formatErrorMessage: (token: Token, message: string) => Error,
  evaluateExpression: (params: {
    expr: Expr;
    env: Environment;
    context: EvaluatorContext;
  }) => Expr
): FuncCallExpr {
  const elements: (ExprValue | UnknownValue)[] = [];
  const args = expr.args;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const evaluatedArg = evaluateExpression({
      expr: arg,
      env,
      context: {
        ...context,
      },
    });
    if (
      !evaluatedArg.$ ||
      !isExprType(evaluatedArg.$.type) ||
      !evaluatedArg.$.value
    ) {
      throw formatErrorMessage(
        arg.token,
        `Failed to evaluate expr_list element. Expected compile-time known expr value:\n${exprToString(arg)}`
      );
    }
    env = evaluatedArg.$.env;
    const value = evaluatedArg.$.value;

    if (
      isExprValue(value) ||
      (isUnknownValue(value) && isExprType(value.type))
    ) {
      elements.push(value);
    } else {
      throw formatErrorMessage(
        arg.token,
        `Expected compile-time known expr value, got ${valueToString(value)}`
      );
    }
  }

  const exprListValue = createExprListValue(elements);
  expr.$ = {
    env,
    type: exprListValue.type,
    value: exprListValue,
    isMutable: false,
    pathCollection: [],
  };
  return expr;
}
