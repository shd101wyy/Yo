import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { Expr, exprIsFunctionCall, FnCallExpr } from "../../expr";
import { createTupleType, createUnitType } from "../../types/creators";
import { TupleType, TypeField } from "../../types/definitions";
import { typeOfType } from "../../types/hierarchy";
import { createTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { validateTypeAvailability } from "../trait-checking";
import { evaluateTypeField } from "./field";
import {
  autoDeriveComptimeForTupleType,
  autoDeriveRuntimeForTupleType,
  autoDeriveSendForTupleType,
} from "./utils";

export function evaluateTupleElementsType({
  args,
  env,
  context,
  forType,
}: {
  args: Expr[];
  env: Environment;
  context: EvaluatorContext;
  forType: "tuple" | "struct" | "enum" | "union";
}): {
  type: TupleType;
  env: Environment;
} {
  const tupleFields: TypeField[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    const { field, env: nextEnv } = evaluateTypeField({
      expr: arg,
      env,
      tupleFieldIndex: i,
      context: { ...context },
      forType,
    });

    // Check if there is duplicate labels
    if (field.label) {
      const duplicateLabel = tupleFields.find(
        (elem) => elem.label === field.label
      );
      if (duplicateLabel) {
        throw formatErrorMessage({
          token: exprIsFunctionCall(arg)
            ? (arg.args[0]?.token ?? arg.token)
            : arg.token,
          errorMessage: `Duplicate label "${field.label}" in tuple`,
        });
      }
    }

    // Check if it's compile-time only
    if (field.isCompileTimeOnly && field.assignedValue) {
      throw formatErrorMessage({
        token: exprIsFunctionCall(arg)
          ? (arg.args[0]?.token ?? arg.token)
          : arg.token,
        errorMessage: `Tuple cannot have module fields.`,
      });
    }

    tupleFields.push(field as TypeField);
    env = nextEnv;
  }

  const tupleType: TupleType = createTupleType(tupleFields);
  return {
    type: tupleType,
    env,
  };
}

export function evaluateTupleType({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  if (expr.args.length === 0) {
    const value = createTypeValue(createUnitType());
    expr.$ = {
      env,
      value,
      type: value.type,
      pathCollection: [],
    };
    return expr;
  }

  const { type: tupleType, env: nextEnv } = evaluateTupleElementsType({
    args: expr.args,
    env,
    context: { ...context },
    forType: "tuple",
  });
  env = nextEnv;

  // We disallow the tuple fields to have defaultValue for the tuple type
  tupleType.fields.forEach((tupleElement) => {
    if (tupleElement.exprs.defaultValueExpr) {
      throw formatErrorMessage({
        token: tupleElement.exprs.defaultValueExpr!.token,
        errorMessage: `Tuple type cannot have default value.`,
      });
    }
  });

  // Auto-derive Send trait if applicable
  env = autoDeriveSendForTupleType({
    tupleType,
    env,
    context,
  });

  // Auto-derive Comptime trait if applicable
  env = autoDeriveComptimeForTupleType({
    tupleType,
    env,
    context,
  });

  // Auto-derive Runtime trait if applicable
  env = autoDeriveRuntimeForTupleType({
    tupleType,
    env,
    context,
  });

  validateTypeAvailability(tupleType, env, expr.token);

  expr.$ = {
    env,
    value: createTypeValue(tupleType),
    type: typeOfType(tupleType),
    pathCollection: [],
  };
  return expr;
}
