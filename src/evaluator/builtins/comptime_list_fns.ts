import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  exprToString,
  FnCallExpr,
} from "../../expr";
import {
  areTypesCompatible,
  createUsizeType,
  isComptimeListType,
  typeToString,
} from "../../types";
import {
  createComptimeListValue,
  createNumberValue,
  createTypeValue,
  createUnknownValue,
  isComptimeListValue,
  isTypeValue,
} from "../../value";
import { ValueTag } from "../../value-tag";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluateYoComptimeListCar({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(
    expr,
    BuiltinFunctions.__yo_comptime_list_car,
    1
  );

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  if (!isComptimeListType(evaluatedArgExpr.$.type)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected ComptimeList type for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr
      )}`,
    });
  }
  const comptimeListType = evaluatedArgExpr.$.type;
  const comptimeListValue = evaluatedArgExpr.$.value;
  if (!comptimeListValue) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected ComptimeList value for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr
      )}`,
    });
  }

  expr.$ = {
    env: evaluatedArgExpr.$.env,
    type: comptimeListType.childType,
    value: createUnknownValue(comptimeListType.childType, {
      env: evaluatedArgExpr.$.env,
    }), // Will be updated later
    pathCollection: [],
    isAccessingProperty: false,
  };

  if (isComptimeListValue(comptimeListValue)) {
    const elements = comptimeListValue.elements;
    if (elements.length > 0) {
      expr.$.value = elements[0]!;
    } else {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Unexpected empty ComptimeList for "${expr.func.token.value}" argument`,
      });
    }
  }

  return expr;
}

export function evaluateYoComptimeListCdr({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(
    expr,
    BuiltinFunctions.__yo_comptime_list_cdr,
    1
  );

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  if (!isComptimeListType(evaluatedArgExpr.$.type)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected ComptimeList type for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr
      )}`,
    });
  }

  const comptimeListType = evaluatedArgExpr.$.type;
  const comptimeListValue = evaluatedArgExpr.$.value;
  if (!comptimeListValue) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected ComptimeList value for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr
      )}`,
    });
  }

  expr.$ = {
    env: evaluatedArgExpr.$.env,
    type: comptimeListType,
    value: createUnknownValue(comptimeListType, {
      env: evaluatedArgExpr.$.env,
    }), // Will be updated later
    pathCollection: [],
    isAccessingProperty: false,
  };

  if (isComptimeListValue(comptimeListValue)) {
    const elements = comptimeListValue.elements;
    if (elements.length > 0) {
      expr.$.value = createComptimeListValue(comptimeListType.childType, [
        ...elements.slice(1),
      ]);
    } else {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Unexpected empty ComptimeList for "${expr.func.token.value}" argument`,
      });
    }
  }

  return expr;
}

export function evaluateYoComptimeListCons({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(
    expr,
    BuiltinFunctions.__yo_comptime_list_cons,
    2
  );

  const carArg = evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: {
      ...context,
    },
  });

  // car
  if (!carArg.$) {
    throw formatErrorMessage({
      token: carArg.token,
      errorMessage: `Failed to evaluate the first argument expression for "${expr.func.token.value}":\n${exprToString(
        carArg
      )}`,
    });
  }
  env = carArg.$.env;
  const carValue = carArg.$.value;
  if (!carValue) {
    throw formatErrorMessage({
      token: carArg.token,
      errorMessage: `Expected Expr value for "${expr.func.token.value}" first argument, got:\n${exprToString(
        carArg
      )}`,
    });
  }

  const cdrArg = evaluateExpression({
    expr: expr.args[1]!,
    env,
    context: {
      ...context,
    },
  });
  if (!cdrArg.$) {
    throw formatErrorMessage({
      token: cdrArg.token,
      errorMessage: `Failed to evaluate the second argument expression for "${expr.func.token.value}":\n${exprToString(
        cdrArg
      )}`,
    });
  }
  env = cdrArg.$.env;
  if (!isComptimeListType(cdrArg.$.type)) {
    throw formatErrorMessage({
      token: cdrArg.token,
      errorMessage: `Expected ComptimeList type for "${expr.func.token.value}" second argument, got:\n${exprToString(
        cdrArg
      )}`,
    });
  }
  const cdrValue = cdrArg.$.value;
  if (!cdrValue) {
    throw formatErrorMessage({
      token: cdrArg.token,
      errorMessage: `Expected ComptimeList value for "${expr.func.token.value}" second argument, got:\n${exprToString(
        cdrArg
      )}`,
    });
  }
  const comptimeListType = cdrArg.$.type;
  const carArgType = carArg.$.type;
  if (
    !areTypesCompatible(
      {
        type: carArgType,
        env,
      },
      { type: comptimeListType.childType, env }
    )
  ) {
    throw formatErrorMessage({
      token: carArg.token,
      errorMessage: `Type mismatch: cannot cons value of type "${typeToString(carArgType)}" to ComptimeList of base type "${typeToString(comptimeListType.childType)}" in "${expr.func.token.value}"`,
    });
  }

  expr.$ = {
    env: env,
    type: comptimeListType,
    value: createUnknownValue(comptimeListType, { env }), // Will be updated later
    pathCollection: [],
    isAccessingProperty: false,
  };

  if (isComptimeListValue(cdrValue)) {
    // Create a new ComptimeList value with the car as the first element
    const newElements = [carValue, ...cdrValue.elements];
    expr.$.value = createComptimeListValue(
      comptimeListType.childType,
      newElements
    );
  } else {
    // cdrValue is unknown
  }

  return expr;
}

export function evaluateYoComptimeListAppend({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(
    expr,
    BuiltinFunctions.__yo_comptime_list_append,
    2
  );

  const firstListArg = evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: {
      ...context,
    },
  });

  if (!firstListArg.$) {
    throw formatErrorMessage({
      token: firstListArg.token,
      errorMessage: `Failed to evaluate the first argument expression for "${expr.func.token.value}":\n${exprToString(
        firstListArg
      )}`,
    });
  }
  env = firstListArg.$.env;
  if (!isComptimeListType(firstListArg.$.type)) {
    throw formatErrorMessage({
      token: firstListArg.token,
      errorMessage: `Expected ComptimeList type for "${expr.func.token.value}" first argument, got:\n${exprToString(
        firstListArg
      )}`,
    });
  }
  const firstListValue = firstListArg.$.value;
  if (!firstListValue) {
    throw formatErrorMessage({
      token: firstListArg.token,
      errorMessage: `Expected Expr value for "${expr.func.token.value}" first argument, got:\n${exprToString(
        firstListArg
      )}`,
    });
  }

  const secondListArg = evaluateExpression({
    expr: expr.args[1]!,
    env,
    context: {
      ...context,
    },
  });
  if (!secondListArg.$) {
    throw formatErrorMessage({
      token: secondListArg.token,
      errorMessage: `Failed to evaluate the second argument expression for "${expr.func.token.value}":\n${exprToString(
        secondListArg
      )}`,
    });
  }
  env = secondListArg.$.env;
  if (!isComptimeListType(secondListArg.$.type)) {
    throw formatErrorMessage({
      token: secondListArg.token,
      errorMessage: `Expected ComptimeList type for "${expr.func.token.value}" second argument, got:\n${exprToString(
        secondListArg
      )}`,
    });
  }
  const secondListValue = secondListArg.$.value;
  if (!secondListValue) {
    throw formatErrorMessage({
      token: secondListArg.token,
      errorMessage: `Expected ComptimeList value for "${expr.func.token.value}" second argument, got:\n${exprToString(
        secondListArg
      )}`,
    });
  }

  // Check if the two ComptimeList have the same type
  const firstComptimeListType = firstListArg.$.type;
  const secondComptimeListType = secondListArg.$.type;
  if (
    !areTypesCompatible(
      {
        type: firstComptimeListType,
        env,
      },
      { type: secondComptimeListType, env }
    )
  ) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Type mismatch: cannot append ComptimeList of base type "${typeToString(secondComptimeListType.childType)}" to ComptimeList of base type "${typeToString(firstComptimeListType.childType)}" in "${expr.func.token.value}"`,
    });
  }

  expr.$ = {
    env: env,
    type: firstComptimeListType,
    value: createUnknownValue(firstComptimeListType, { env }), // Will be updated later
    pathCollection: [],
    isAccessingProperty: false,
  };

  if (isComptimeListValue(firstListValue)) {
    if (isComptimeListValue(secondListValue)) {
      // merge two ComptimeList values
      const newElements = [
        ...firstListValue.elements,
        ...secondListValue.elements,
      ];
      expr.$.value = createComptimeListValue(
        firstComptimeListType.childType,
        newElements
      );
    } else {
      // cdrValue is unknown
    }
  } else {
    // unknown value;
  }

  return expr;
}

export function evaluateYoComptimeListLength({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(
    expr,
    BuiltinFunctions.__yo_comptime_list_length,
    1
  );

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  if (!isComptimeListType(evaluatedArgExpr.$.type)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected ComptimeList type for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr
      )}`,
    });
  }
  const comptimeListValue = evaluatedArgExpr.$.value;
  if (!comptimeListValue) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected ComptimeList value for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr
      )}`,
    });
  }

  expr.$ = {
    env: evaluatedArgExpr.$.env,
    type: createUsizeType(),
    value: createUnknownValue(createUsizeType(), {
      env: evaluatedArgExpr.$.env,
    }), // Will be updated later
    pathCollection: [],
    isAccessingProperty: false,
  };

  if (isComptimeListValue(comptimeListValue)) {
    const length = comptimeListValue.elements.length;
    const lengthValue = createNumberValue(ValueTag.Usize, length);
    expr.$.value = lengthValue;
  }

  return expr;
}

export function evaluateYoComptimeListElementType({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(
    expr,
    BuiltinFunctions.__yo_comptime_list_element_type,
    1
  );

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
        argExpr
      )}`,
    });
  }
  if (!isTypeValue(evaluatedArgExpr.$?.value)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected ComptimeList type for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr
      )}`,
    });
  }

  const comptimeListType = evaluatedArgExpr.$.value.value;
  if (!isComptimeListType(comptimeListType)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected ComptimeList type for "${expr.func.token.value}" argument, got:\n${typeToString(
        comptimeListType
      )}`,
    });
  }

  const typeValue = createTypeValue(comptimeListType.childType);

  expr.$ = {
    env: evaluatedArgExpr.$.env,
    type: typeValue.type,
    value: typeValue,
    pathCollection: [],
    isAccessingProperty: false,
  };
  return expr;
}
