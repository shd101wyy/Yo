import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  expectExprToBeFunctionCallOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { Token } from "../../token";
import {
  areTypesCompatible,
  createTypeHierarchy,
  isModuleType,
  isSomeType,
  ModuleField,
  ModuleType,
  Type,
  typeToString,
} from "../../types";
import { createTypeValue, isModuleValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Check if a type implements a specific module.
 * @returns true if the type implements the module, false otherwise
 */
export function typeImplementsModule({
  targetType,
  moduleType,
  env,
}: {
  targetType: Type;
  moduleType: ModuleType;
  env: Environment;
}): boolean {
  const expectedModuleWithReceiver: ModuleType = {
    ...moduleType,
    receiverType: targetType,
  };

  const targetModule = targetType.module;
  if (!targetModule) {
    return false;
  }

  for (const field of targetModule.fields) {
    if (!field.assignedValue || !isModuleValue(field.assignedValue)) {
      continue;
    }

    const fieldModuleValue = field.assignedValue;
    const fieldModuleType = fieldModuleValue.type;

    if (
      areTypesCompatible(
        { type: expectedModuleWithReceiver, env },
        { type: fieldModuleType, env }
      )
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a type implements all the selfConstraints of a module type.
 * Throws an error if any constraint is not satisfied.
 */
export function checkTypeImplementsSelfConstraints({
  targetType,
  moduleType,
  env,
  errorToken,
}: {
  targetType: Type;
  moduleType: ModuleType;
  env: Environment;
  errorToken: Token;
}): void {
  if (!moduleType.selfConstraints || moduleType.selfConstraints.length === 0) {
    return;
  }

  for (const constraintModule of moduleType.selfConstraints) {
    if (
      !typeImplementsModule({ targetType, moduleType: constraintModule, env })
    ) {
      throw formatErrorMessage({
        token: errorToken,
        errorMessage: `Type "${typeToString(targetType)}" does not implement required constraint "${constraintModule.typeName ?? typeToString(constraintModule)}" from module "${moduleType.typeName ?? typeToString(moduleType)}"'s where clause.`,
      });
    }
  }
}

/*

    use_id :: 
      (fn(
        forall(T : Type),
        value : T,
        using(IdInstance : (T <: Id))
      ) -> value) {
      return IdInstance.id(value);
    };

    Here T <: Id means that T is a subtype of Id, which is a type that has an id method.
 */
export function evaluateSubtypeOf({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  expectExprToBeFunctionCallOf(expr, "<:", 2);
  const lhsExpr = expr.args[0]!;
  const rhsExpr = expr.args[1]!;

  // Evaluate the lhsExpr
  const evaluatedLhs = evaluateExpression({
    expr: lhsExpr,
    env,
    context: {
      ...context,
    },
  });

  // Expect the lhs to be a type
  if (
    !evaluatedLhs.$ ||
    !evaluatedLhs.$.value ||
    !isTypeValue(evaluatedLhs.$.value)
  ) {
    throw formatErrorMessage({
      token: lhsExpr.token,
      errorMessage: `Expected type for left-hand side expression.`,
    });
  }
  env = evaluatedLhs.$.env;
  const typeValue = evaluatedLhs.$.value;

  // In a where clause, the LHS must be a SomeType (type parameter)
  if (context.isInsideWhereClause && !isSomeType(typeValue.value)) {
    throw formatErrorMessage({
      token: lhsExpr.token,
      errorMessage: `In a where clause, the left-hand side of <: must be a type parameter (SomeType), got: ${exprToString(lhsExpr)}`,
    });
  }

  // Collect module expressions to process
  // Support both single module and tuple of modules: T <: Module or T <: (Module1, Module2)
  const moduleExprs: { expr: typeof rhsExpr }[] = [];
  if (exprIsFunctionCall(rhsExpr) && exprIsFunctionCallOf(rhsExpr, ",")) {
    // Tuple form: (Module1, Module2, ...)
    for (const moduleExpr of rhsExpr.args) {
      moduleExprs.push({ expr: moduleExpr });
    }
  } else {
    // Single module form
    moduleExprs.push({ expr: rhsExpr });
  }

  // Process each module
  const moduleTypes: { moduleType: ModuleType; expr: typeof rhsExpr }[] = [];
  for (const { expr: moduleExpr } of moduleExprs) {
    const evaluatedRhs = evaluateExpression({
      expr: moduleExpr,
      env,
      context: {
        ...context,
      },
    });

    // Expect the rhs to be a module type
    if (
      !evaluatedRhs.$ ||
      !evaluatedRhs.$.value ||
      !isTypeValue(evaluatedRhs.$.value) ||
      !isModuleType(evaluatedRhs.$.value.value)
    ) {
      throw formatErrorMessage({
        token: moduleExpr.token,
        errorMessage: `Expected module type for right-hand side expression.`,
      });
    }
    env = evaluatedRhs.$.env;
    const moduleType = evaluatedRhs.$.value.value;

    if (moduleType.receiverType) {
      throw formatErrorMessage({
        token: moduleExpr.token,
        errorMessage: `Expected module type already has a receiver type assigned.`,
      });
    }

    moduleTypes.push({ moduleType, expr: moduleExpr });
  }

  // In a where clause, add the module constraints to the SomeType's module
  if (context.isInsideWhereClause && isSomeType(typeValue.value)) {
    const someType = typeValue.value;

    for (const { moduleType, expr: moduleExpr } of moduleTypes) {
      // Create a copy of the module with receiverType set to the someType
      const moduleWithReceiver: ModuleType = {
        ...moduleType,
        receiverType: someType,
      };
      // Use empty label to prevent direct access - only method calls are allowed
      const label = "";
      const field: ModuleField = {
        label,
        type: createTypeHierarchy(1), // Module type
        isCompileTimeOnly: true,
        assignedValue: createTypeValue(moduleWithReceiver),
        exprs: {
          expr: moduleExpr,
        },
      };
      someType.module.fields.push(field);
    }

    // Return the original typeValue (the SomeType itself)
    expr.$ = {
      env,
      value: typeValue,
      type: typeValue.type,
      pathCollection: [],
    };
    return expr;
  }

  // Non-where clause case: only single module is allowed
  if (moduleTypes.length > 1) {
    throw formatErrorMessage({
      token: rhsExpr.token,
      errorMessage: `Multiple module constraints (tuple form) are only allowed in where clauses.`,
    });
  }

  const { moduleType } = moduleTypes[0]!;
  const targetType = typeValue.value;

  // Verify that the LHS type actually implements the RHS module
  // Skip this check for SomeType (type parameters) as they are checked at instantiation time
  if (!isSomeType(targetType)) {
    if (!typeImplementsModule({ targetType, moduleType, env })) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Type "${typeToString(targetType)}" does not implement module "${moduleType.typeName ?? typeToString(moduleType)}".`,
      });
    }
  }

  /// Override the assigned value of the This element with the typeValue.
  const newModuleType: ModuleType = {
    ...moduleType,
    receiverType: typeValue.value, // Set the subtype to the typeValue
  };
  const newModuleTypeValue = createTypeValue(newModuleType);

  expr.$ = {
    env,
    value: newModuleTypeValue,
    type: newModuleTypeValue.type,
    pathCollection: [],
  };
  return expr;
}
