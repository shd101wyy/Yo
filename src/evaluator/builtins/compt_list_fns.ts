import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import {
  areTypesCompatible,
  createUsizeType,
  isComptListType,
  typeToString,
} from "../../types";
import {
  createComptListValue,
  createNumberValue,
  createTypeValue,
  createUnknownValue,
  isComptListValue,
  isTypeValue,
} from "../../value";
import { ValueTag } from "../../value-tag";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluateYoComptListCar({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_compt_list_car, 1);

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
        argExpr,
      )}`,
    });
  }
  if (!isComptListType(evaluatedArgExpr.$.type)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected ComptList type for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr,
      )}`,
    });
  }
  const comptListType = evaluatedArgExpr.$.type;
  const comptListValue = evaluatedArgExpr.$.value;
  if (!comptListValue) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected ComptList value for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr,
      )}`,
    });
  }

  expr.$ = {
    env: evaluatedArgExpr.$.env,
    type: comptListType.childType,
    value: createUnknownValue(comptListType.childType), // Will be updated later
    pathCollection: [],
    isAccessingProperty: false,
  };

  if (isComptListValue(comptListValue)) {
    const elements = comptListValue.elements;
    if (elements.length > 0) {
      expr.$.value = elements[0]!;
    } else {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Unexpected empty ComptList for "${expr.func.token.value}" argument`,
      });
    }
  }

  return expr;
}

export function evaluateYoComptListCdr({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_compt_list_cdr, 1);

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
        argExpr,
      )}`,
    });
  }
  if (!isComptListType(evaluatedArgExpr.$.type)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected ComptList type for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr,
      )}`,
    });
  }

  const comptListType = evaluatedArgExpr.$.type;
  const comptListValue = evaluatedArgExpr.$.value;
  if (!comptListValue) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected ComptList value for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr,
      )}`,
    });
  }

  expr.$ = {
    env: evaluatedArgExpr.$.env,
    type: comptListType,
    value: createUnknownValue(comptListType), // Will be updated later
    pathCollection: [],
    isAccessingProperty: false,
  };

  if (isComptListValue(comptListValue)) {
    const elements = comptListValue.elements;
    if (elements.length > 0) {
      expr.$.value = createComptListValue(comptListType.childType, [
        ...elements.slice(1),
      ]);
    } else {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Unexpected empty ComptList for "${expr.func.token.value}" argument`,
      });
    }
  }

  return expr;
}

export function evaluateYoComptListCons({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_compt_list_cons, 2);

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
        carArg,
      )}`,
    });
  }
  env = carArg.$.env;
  const carValue = carArg.$.value;
  if (!carValue) {
    throw formatErrorMessage({
      token: carArg.token,
      errorMessage: `Expected Expr value for "${expr.func.token.value}" first argument, got:\n${exprToString(
        carArg,
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
        cdrArg,
      )}`,
    });
  }
  env = cdrArg.$.env;
  if (!isComptListType(cdrArg.$.type)) {
    throw formatErrorMessage({
      token: cdrArg.token,
      errorMessage: `Expected ComptList type for "${expr.func.token.value}" second argument, got:\n${exprToString(
        cdrArg,
      )}`,
    });
  }
  const cdrValue = cdrArg.$.value;
  if (!cdrValue) {
    throw formatErrorMessage({
      token: cdrArg.token,
      errorMessage: `Expected ComptList value for "${expr.func.token.value}" second argument, got:\n${exprToString(
        cdrArg,
      )}`,
    });
  }
  const comptListType = cdrArg.$.type;
  const carArgType = carArg.$.type;
  if (
    !areTypesCompatible(
      {
        type: carArgType,
        env,
      },
      { type: comptListType.childType, env },
    )
  ) {
    throw formatErrorMessage({
      token: carArg.token,
      errorMessage: `Type mismatch: cannot cons value of type "${typeToString(carArgType)}" to ComptList of base type "${typeToString(comptListType.childType)}" in "${expr.func.token.value}"`,
    });
  }

  expr.$ = {
    env: env,
    type: comptListType,
    value: createUnknownValue(comptListType), // Will be updated later
    pathCollection: [],
    isAccessingProperty: false,
  };

  if (isComptListValue(cdrValue)) {
    // Create a new ComptList value with the car as the first element
    const newElements = [carValue, ...cdrValue.elements];
    expr.$.value = createComptListValue(comptListType.childType, newElements);
  } else {
    // cdrValue is unknown
  }

  return expr;
}

export function evaluateYoComptListAppend({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(
    expr,
    BuiltinFunctions.__yo_compt_list_append,
    2,
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
        firstListArg,
      )}`,
    });
  }
  env = firstListArg.$.env;
  if (!isComptListType(firstListArg.$.type)) {
    throw formatErrorMessage({
      token: firstListArg.token,
      errorMessage: `Expected ComptList type for "${expr.func.token.value}" first argument, got:\n${exprToString(
        firstListArg,
      )}`,
    });
  }
  const firstListValue = firstListArg.$.value;
  if (!firstListValue) {
    throw formatErrorMessage({
      token: firstListArg.token,
      errorMessage: `Expected Expr value for "${expr.func.token.value}" first argument, got:\n${exprToString(
        firstListArg,
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
        secondListArg,
      )}`,
    });
  }
  env = secondListArg.$.env;
  if (!isComptListType(secondListArg.$.type)) {
    throw formatErrorMessage({
      token: secondListArg.token,
      errorMessage: `Expected ComptList type for "${expr.func.token.value}" second argument, got:\n${exprToString(
        secondListArg,
      )}`,
    });
  }
  const secondListValue = secondListArg.$.value;
  if (!secondListValue) {
    throw formatErrorMessage({
      token: secondListArg.token,
      errorMessage: `Expected ComptList value for "${expr.func.token.value}" second argument, got:\n${exprToString(
        secondListArg,
      )}`,
    });
  }

  // Check if the two ComptList have the same type
  const firstComptListType = firstListArg.$.type;
  const secondComptListType = secondListArg.$.type;
  if (
    !areTypesCompatible(
      {
        type: firstComptListType,
        env,
      },
      { type: secondComptListType, env },
    )
  ) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Type mismatch: cannot append ComptList of base type "${typeToString(secondComptListType.childType)}" to ComptList of base type "${typeToString(firstComptListType.childType)}" in "${expr.func.token.value}"`,
    });
  }

  expr.$ = {
    env: env,
    type: firstComptListType,
    value: createUnknownValue(firstComptListType), // Will be updated later
    pathCollection: [],
    isAccessingProperty: false,
  };

  if (isComptListValue(firstListValue)) {
    if (isComptListValue(secondListValue)) {
      // merge two ComptList values
      const newElements = [
        ...firstListValue.elements,
        ...secondListValue.elements,
      ];
      expr.$.value = createComptListValue(
        firstComptListType.childType,
        newElements,
      );
    } else {
      // cdrValue is unknown
    }
  } else {
    // unknown value;
  }

  return expr;
}

export function evaluateYoComptListLength({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(
    expr,
    BuiltinFunctions.__yo_compt_list_length,
    1,
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
        argExpr,
      )}`,
    });
  }
  if (!isComptListType(evaluatedArgExpr.$.type)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected ComptList type for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr,
      )}`,
    });
  }
  const comptListValue = evaluatedArgExpr.$.value;
  if (!comptListValue) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected ComptList value for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr,
      )}`,
    });
  }

  expr.$ = {
    env: evaluatedArgExpr.$.env,
    type: createUsizeType(),
    value: createUnknownValue(createUsizeType()), // Will be updated later
    pathCollection: [],
    isAccessingProperty: false,
  };

  if (isComptListValue(comptListValue)) {
    const length = comptListValue.elements.length;
    const lengthValue = createNumberValue(ValueTag.Usize, length);
    expr.$.value = lengthValue;
  }

  return expr;
}

export function evaluateYoComptListElementType({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(
    expr,
    BuiltinFunctions.__yo_compt_list_element_type,
    1,
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
        argExpr,
      )}`,
    });
  }
  if (!isTypeValue(evaluatedArgExpr.$?.value)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected ComptList type for "${expr.func.token.value}" argument, got:\n${exprToString(
        argExpr,
      )}`,
    });
  }

  const comptListType = evaluatedArgExpr.$.value.value;
  if (!isComptListType(comptListType)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected ComptList type for "${expr.func.token.value}" argument, got:\n${typeToString(
        comptListType,
      )}`,
    });
  }

  const typeValue = createTypeValue(comptListType.childType);

  expr.$ = {
    env: evaluatedArgExpr.$.env,
    type: typeValue.type,
    value: typeValue,
    pathCollection: [],
    isAccessingProperty: false,
  };
  return expr;
}
