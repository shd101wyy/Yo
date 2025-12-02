import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  expectExprToBeFunctionCallOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import {
  areTypesCompatible,
  createTypeHierarchy,
  isModuleType,
  isSomeType,
  ModuleField,
  ModuleType,
  typeToString,
} from "../../types";
import { createTypeValue, isModuleValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

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
    // Create a version of the expected module with targetType as the receiver
    const expectedModuleWithReceiver: ModuleType = {
      ...moduleType,
      receiverType: targetType,
    };

    // Check if the target type's module has a field that implements the expected module
    let impls = false;
    const targetModule = targetType.module;
    if (targetModule) {
      for (const field of targetModule.fields) {
        if (!field.assignedValue || !isModuleValue(field.assignedValue)) {
          continue;
        }

        const fieldModuleValue = field.assignedValue;
        const fieldModuleType = fieldModuleValue.type;

        // Check if this field's module type is compatible with the expected module
        // The field module should have the target type as its receiver
        if (
          areTypesCompatible(
            { type: expectedModuleWithReceiver, env },
            { type: fieldModuleType, env }
          )
        ) {
          impls = true;
          break;
        }
      }
    }

    if (!impls) {
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
