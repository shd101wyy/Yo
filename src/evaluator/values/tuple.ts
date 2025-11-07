import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinKeywords,
  Expr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
  setExprAsNeedsToCallDup,
} from "../../expr";
import {
  convertComptTypeToRuntimeType,
  createTupleType,
  isTupleType,
  TupleType,
  Type,
  TypeField,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import { createTupleValue, isTypeValue, TupleValue, Value } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Evaluate the field in tuple rvalue, such as
 * value:
 * 14  in (14, ...)
 * (x: 16) in (x: 16, ...)
 *
 */
export function evaluateTupleElementValue({
  expr,
  tupleFieldIndex,
  env,
  context,
  elementIndex,
  runtimeArgExprsInOrder,
}: {
  expr: Expr;
  tupleFieldIndex: number;
  env: Environment;
  context: EvaluatorContext;
  elementIndex: number;
  runtimeArgExprsInOrder: Expr[];
}): {
  type: TypeField;
  value: Value | undefined;
  env: Environment;
} {
  const expr_ = expr;
  const rhsExpr: Expr = expr;
  let childType: Type | undefined = undefined;

  // Parse the lhs expr
  if (exprIsFunctionCall(expr_) && exprIsFunctionCallOf(expr_, ":", 2)) {
    const lhsExpr = expr_.args[0]!;

    throw formatErrorMessage({
      token: lhsExpr.token,
      errorMessage: `Labelled field is not allowed in tuple value.`,
    });
  }

  // Check expectedType
  const expectedTupleType = context.expectedType?.type;
  let expectedTupleFieldType: Type | undefined = undefined;
  if (expectedTupleType) {
    if (!isTupleType(expectedTupleType)) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `(2) Failed to evaluate the tuple fields. Expected type to be:
${typeToString(expectedTupleType)}`,
      });
    }
    const tupleField = expectedTupleType.fields[tupleFieldIndex];
    if (!tupleField) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Failed to get the tuple field at index ${tupleFieldIndex}`,
      });
    }
    expectedTupleFieldType = tupleField.type;
  }

  // Parse the rhs expr
  const evaluatedRhs = evaluateExpression({
    expr: rhsExpr,
    env,
    context: {
      ...context,
      expectedType: expectedTupleFieldType
        ? {
            type: expectedTupleFieldType,
            env,
          }
        : undefined,
    },
  });

  setExprAsNeedsToCallDup(evaluatedRhs, context);

  if (!evaluatedRhs.$) {
    throw formatErrorMessage({
      token: rhsExpr.token,
      errorMessage: `Failed to evaluate the tuple field: ${exprToString(rhsExpr)}`,
    });
  }
  env = evaluatedRhs.$.env;

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
  childType = convertComptTypeToRuntimeType({
    type: evaluatedRhs.$.type,
    expectedType: undefined,
    expr: undefined,
    env,
    context: { ...context },
  });

  // Add to runtimeArgExprsInOrder
  runtimeArgExprsInOrder.push(evaluatedRhs);

  if (expr !== rhsExpr) {
    expr.$ = {
      env,
      type: childType,
      value: value,
      pathCollection: [],
    };
  }

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
      type: childType,
      label: elementIndex.toString(), // `$field_${randomId()}`,
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
  const tupleElements: TypeField[] = [];
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
      tupleFieldIndex: i,
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
    ? // ^ Meaning some field value is not compile-time known.
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
      pathCollection: [],
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

  // We disallow the tuple fields to have defaultValue for the tuple type
  // We disallow the tuple value to have labels. Only the tuple type can have labels.
  tupleType.fields.forEach((tupleField) => {
    if (tupleField.exprs.defaultValueExpr) {
      throw formatErrorMessage({
        token: tupleField.exprs.defaultValueExpr!.token,
        errorMessage: `Tuple value field cannot have default value.`,
      });
    }

    if (tupleField.exprs.labelExpr) {
      throw formatErrorMessage({
        token: tupleField.exprs.labelExpr!.token,
        errorMessage: `Tuple value field cannot have labels.`,
      });
    }
  });

  expr.$ = {
    env,
    value: tupleValue,
    type: tupleType,
    pathCollection: [],
    runtimeArgExprsInOrder,
  };

  // Attach temp variable to the expr
  attachTempVariableToExpr(expr, true);

  return expr;
}
