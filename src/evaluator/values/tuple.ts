import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  Expr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
  setExprAsConsumed,
} from "../../expr";
import {
  convertComptTypeToRuntimeType,
  createTupleType,
  isTupleType,
  TupleElement,
  TupleType,
  Type,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import { createTupleValue, isTypeValue, TupleValue, Value } from "../../value";
import { EvaluatorContext } from "../context";

/**
 * Evaluate the element in tuple rvalue, such as
 * value:
 * 14  in (14, ...)
 * (x: 16) in (x: 16, ...)
 *
 */
export function evaluateTupleElementValue({
  expr,
  tupleElementIndex,
  env,
  context,
  elementIndex,
  runtimeArgExprsInOrder,
}: {
  expr: Expr;
  tupleElementIndex: number;
  env: Environment;
  context: EvaluatorContext;
  elementIndex: number;
  runtimeArgExprsInOrder: Expr[];
}): {
  type: TupleElement;
  value: Value | undefined;
  env: Environment;
} {
  const expr_ = expr;
  const rhsExpr: Expr = expr;
  let elementType: Type | undefined = undefined;

  // Parse the lhs expr
  if (exprIsFunctionCall(expr_) && exprIsFunctionCallOf(expr_, ":", 2)) {
    const lhsExpr = expr_.args[0]!;

    throw formatErrorMessage({
      token: lhsExpr.token,
      errorMessage: `Labelled element is not allowed in tuple value.`,
    });
  }

  // Check expectedType
  const expectedTupleType = context.expectedType?.type;
  let expectedTupleElementType: Type | undefined = undefined;
  if (expectedTupleType) {
    if (!isTupleType(expectedTupleType)) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `(2) Failed to evaluate the tuple elements. Expected type to be:
${typeToString(expectedTupleType)}`,
      });
    }
    const tupleElement = expectedTupleType.elements[tupleElementIndex];
    if (!tupleElement) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Failed to get the tuple element at index ${tupleElementIndex}`,
      });
    }
    expectedTupleElementType = tupleElement.type;
  }

  // Parse the rhs expr
  const evaluatedRhs = context.evaluateExpression({
    expr: rhsExpr,
    env,
    context: {
      ...context,
      expectedType: expectedTupleElementType
        ? {
            type: expectedTupleElementType,
            env,
          }
        : undefined,
    },
  });

  if (!evaluatedRhs.$) {
    throw formatErrorMessage({
      token: rhsExpr.token,
      errorMessage: `Failed to evaluate the tuple element: ${exprToString(rhsExpr)}`,
    });
  }
  env = evaluatedRhs.$.env;

  // Set the evaluatedRhs as consumed
  env = setExprAsConsumed(evaluatedRhs, env, context);

  const value = evaluatedRhs.$.value;
  if (value && isTypeValue(evaluatedRhs.$.value)) {
    throw formatErrorMessage({
      token: rhsExpr.token,
      errorMessage: `Cannot store a type value in tuple, please use module instead:
  ${exprToString(rhsExpr)}`,
    });
  }

  // Tuple can only accept runtime values, so we convert the type
  // to runtime type.
  elementType = convertComptTypeToRuntimeType(evaluatedRhs.$.type);

  // Add to runtimeArgExprsInOrder
  runtimeArgExprsInOrder.push(evaluatedRhs);

  expr.$ = {
    env,
    type: elementType,
    value: value,
    isMutable: evaluatedRhs.$?.isMutable ?? false,
  };
  return {
    type: {
      exprs: {
        expr: expr,
        labelExpr: undefined,
        typeExpr: undefined,
        defaultValueExpr: undefined,
        assignedValueExpr: undefined,
      },
      isCompileTimeOnly: false,
      isImplicit: false,
      type: elementType,
      label: elementIndex.toString(), // `$element_${randomId()}`,
    },
    value,
    env,
  };
}

/**
 */
export function evaluateTupleElementsValue({
  args,
  env,
  context,
}: {
  args: Expr[];
  env: Environment;
  context: EvaluatorContext;
}): {
  type: TupleType;
  value: TupleValue | undefined;
  env: Environment;
  runtimeArgExprsInOrder: Expr[];
} {
  const tupleElements: TupleElement[] = [];
  const tupleValues: (Value | undefined)[] = [];
  const runtimeArgExprsInOrder: Expr[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    const {
      type,
      value,
      env: nextEnv,
    } = evaluateTupleElementValue({
      expr: arg,
      env,
      tupleElementIndex: i,
      context: { ...context },
      elementIndex: i,
      runtimeArgExprsInOrder,
    });

    tupleElements.push(type);
    tupleValues.push(value);
    env = nextEnv;
  }

  const tupleType: TupleType = createTupleType(tupleElements);
  const value: Value | undefined = tupleValues.some((v) => !v)
    ? // ^ Meaning some element value is not compile-time known.
      undefined
    : createTupleValue(tupleType, tupleValues as Value[]);

  return {
    type: tupleType,
    value,
    env,
    runtimeArgExprsInOrder,
  };
}

export function evaluateTupleValue({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.tuple)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected tuple, got ${expr.tag}`,
    });
  }

  if (expr.args.length === 0) {
    // Unit
    expr.$ = {
      env,
      value: VUnit,
      type: VUnit.type,
      isMutable: false,
    };
    return expr;
  }

  const {
    type: tupleType,
    value: tupleValue,
    env: nextEnv,
    runtimeArgExprsInOrder,
  } = evaluateTupleElementsValue({ args: expr.args, env, context });
  env = nextEnv;

  // We disallow the tuple elements to have defaultValue for the tuple type
  // We disallow the tuple value to have labels. Only the tuple type can have labels.
  tupleType.elements.forEach((tupleElement) => {
    if (tupleElement.exprs.defaultValueExpr) {
      throw formatErrorMessage({
        token: tupleElement.exprs.defaultValueExpr!.token,
        errorMessage: `Tuple type cannot have default value.`,
      });
    }

    if (tupleElement.exprs.labelExpr) {
      throw formatErrorMessage({
        token: tupleElement.exprs.labelExpr!.token,
        errorMessage: `Tuple value cannot have labels.`,
      });
    }
  });

  expr.$ = {
    env,
    value: tupleValue,
    type: tupleType,
    isMutable: true,

    runtimeArgExprsInOrder,
  };
  return expr;
}
