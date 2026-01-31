import { addVariableToEnv, Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FnCallExpr,
  requireExprNotConsumed,
  setExprAsNeedsToCallDup,
} from "../../expr";
import {
  areTypesCompatible,
  convertComptimeTypeToRuntimeType,
  isSomeType,
  prohibitVoidType,
  SomeType,
  typeContainsRcType,
  typeProhibitsComptimeModifier,
  typeRequiresComptimeModifier,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import {
  createUnknownValue,
  isFunctionValue,
  isModuleValue,
  isTraitValue,
  isTypeValue,
} from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { synthesizeExprAndType } from "../types/expr_synthesizer";
import { findRcValueOwnerRelationship, isValidVariableName } from "../utils";
import { cloneValue } from "../values/clone_value";
import { throwRhsContainsControlFlowExpressionError } from "./assignment";
import { evaluateDestructuringAssignment } from "./destructuring_assignment";

/**
 * Evaluate the initialization assignment
 * - ::
 * - :=
 */
export function evaluateInitializationAssignment({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  if (
    !exprIsFunctionCallOf(expr, ":=", 2) &&
    !exprIsFunctionCallOf(expr, "::", 2)
  ) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected ":=" or "::" for initialization assignment.`,
    });
  }
  // During CTFE (when forceCompileTimeBindings is true), treat `:=` as `::`
  const isCompileTimeOnly =
    exprIsFunctionCallOf(expr, "::") ||
    context.forceCompileTimeBindings === true;

  // For type conversion purposes, only consider :: as compile-time.
  // When using := with forceCompileTimeBindings, we evaluate at compile-time
  // but still convert types (e.g., comptime_int -> i32).
  const shouldConvertToRuntimeType = !exprIsFunctionCallOf(expr, "::");

  if (
    !isCompileTimeOnly &&
    context.isEvaluatingFunctionBodyOrAsyncBlock?.kind === "function-body" &&
    context.isEvaluatingFunctionBodyOrAsyncBlock.type.return.isCompileTimeOnly
  ) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Unexpected runtime variable declaration in a compile-time only function body.`,
    });
  }

  const lhs = expr.args[0]!;
  let rhs = expr.args[1]!;

  // Prevent declaring variable type using :: or :=
  if (exprIsFunctionCall(lhs) && exprIsFunctionCallOf(lhs, ":")) {
    throw formatErrorMessage({
      token: lhs.token,
      errorMessage: `Unexpected use of ":" in type declaration with "${
        expr.token.value
      }". Please consider using "=":
(${exprToString(lhs)}) = ${exprToString(rhs)}`,
    });
  }

  // Evaluate the rhs expression
  rhs = evaluateExpression({
    expr: rhs,
    env,
    context: {
      ...context,
      expectedType: undefined,
    },
  });

  if (rhs.$?.env) {
    env = rhs.$?.env;
  }

  if (rhs.$?.type) {
    // Prohibit the rhs to be a void
    prohibitVoidType(rhs.$.type, rhs.token);
  }

  if (rhs.$?.controlFlow) {
    // Check if the RHS is a cond expression to provide a more specific error message
    throwRhsContainsControlFlowExpressionError(rhs, rhs.$.controlFlow);
  }

  if (exprIsAtom(lhs)) {
    // Check if the RHS variable has been consumed (moved)
    requireExprNotConsumed(rhs, env);

    // Insert dup
    // NOTE: For destructuring in `else` block, we don't insert dup there.
    //       Because for simplicity destructuring uses borrowing, not owning.
    setExprAsNeedsToCallDup(rhs, { ...context });
    if (rhs.$?.env) {
      env = rhs.$?.env;
    }

    if (!isValidVariableName(lhs)) {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Invalid assignment to ${lhs.token.value}, expected identifier or operator`,
      });
    }

    // Set the variable type
    let rhsType = rhs.$?.type;
    if (!lhs.$?.type) {
      if (!rhsType) {
        throw formatErrorMessage({
          token: rhs.token,
          errorMessage: `Failed to evaluate, got ${exprToString(rhs)}`,
        });
      }

      // If it's runtime, then we convert
      // comptime_int -> i32
      // comptime_float -> f64
      // etc...
      let lhsType = rhsType;
      if (shouldConvertToRuntimeType) {
        lhsType = convertComptimeTypeToRuntimeType({
          type: rhsType,
          expectedType: undefined,
          expr: rhs,
          env,
        });
      }

      // user didn't specify the type
      lhs.$ = {
        ...lhs.$,
        env,
        type: lhsType,
        pathCollection: [],
      };
    } else {
      // If !rhsType, then check if rhs is a function call of _ or a tuple containing _
      try {
        // Infer the type
        const {
          expr: nextRhs,
          type: nextRhsType,
          env: nextEnv,
        } = synthesizeExprAndType({
          expr: rhs,
          type: lhs.$?.type,
          env: env,
          context: { ...context },
        });
        rhs = nextRhs;
        rhsType = nextRhsType;
        // as it is actually lhs.type if not synthesized.
        env = nextEnv;
      } catch (e) {
        throw formatErrorMessage({
          token: rhs.token,
          errorMessage: `(evaluateInitializationAssignment) Failed to synthesize type for expression: ${exprToString(
            rhs
          )}\n${e}`,
        });
      }

      // Check if the type is compatible
      if (
        !areTypesCompatible({ type: lhs.$.type, env }, { type: rhsType, env })
      ) {
        throw formatErrorMessage({
          token: lhs.token,
          errorMessage: `Incompatible types:
- Defined: ${typeToString(lhs.$.type)}
- Given  : ${typeToString(rhsType)}`,
        });
      }
    }

    // Check some value that requires compile-time only
    if (!isCompileTimeOnly && typeRequiresComptimeModifier(lhs.$.type)) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected "::" instead of ":=" for compile-time known value assignment:
${exprToString(expr)}

Type:
${typeToString(lhs.$.type)}`,
      });
    }
    if (isCompileTimeOnly && typeProhibitsComptimeModifier(lhs.$.type)) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected ":=" instead of "::" for value type "${typeToString(lhs.$.type)}" which can only be used at the runtime:
${exprToString(expr)}`,
      });
    }

    // Add .typeName info if necessary
    // But don't modify context.SelfType - it refers to the enclosing type
    const rhsValue = rhs.$?.value;
    if (
      isTypeValue(rhsValue) &&
      /*
        (isStructType(rhsValue.value) ||
          isEnumType(rhsValue.value) ||
          isUnionType(rhsValue.value) ||
          isModuleType(rhsValue.value)) &&
        */
      !rhsValue.value.typeName &&
      rhsValue.value !== context.SelfType
    ) {
      rhsValue.value.typeName = lhs.token.value;
    } else if (isFunctionValue(rhsValue) && !rhsValue.funcName) {
      rhsValue.funcName = lhs.token.value;
      rhsValue.funcId += `_${lhs.token.value}`;
    } else if (
      (isModuleValue(rhsValue) || isTraitValue(rhsValue)) &&
      !rhsValue.type.typeName &&
      rhsValue.type !== context.SelfType
    ) {
      rhsValue.type.typeName = lhs.token.value;
    }

    // No consumption logic needed

    // Prohibit assigning runtime value to comptime-only variable
    if (!rhsValue && isCompileTimeOnly) {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Expected compile-time value for "${lhs.token.value}".
Got runtime value. Please consider using ":=" instead of "::":
${exprToString(rhs)}`,
      });
    }

    // Set the variable value
    // For compile-time values, use cloneValue to ensure deep copy (value semantics)
    // This prevents mutations to one variable from affecting another
    // e.g., arr2 :: arr1 should create an independent copy
    // cloneValue with preservePointerReferences=true (default) ensures that pointers
    // maintain reference semantics even when nested in data structures
    lhs.$ = {
      ...lhs.$,
      env,
      type: lhs.$.type,
      value: isCompileTimeOnly
        ? rhsValue
          ? cloneValue(rhsValue) // preservePointerReferences=true by default
          : createUnknownValue(lhs.$.type, lhs.token.value)
        : undefined,
      pathCollection: [],
    };

    // Add variable to env
    // Attach the updated env to expr

    // For SomeType (Impl(...)), copy the resolvedConcreteType from RHS to LHS type.
    // This is crucial for closures where the capture struct type is determined at initialization time.
    // The resolvedConcreteType is needed by mergeAndCheckEnvs to verify that all branches
    // have compatible concrete types (Impl uses static dispatch, so concrete type must be known).
    let finalLhsType = lhs.$.type;
    if (
      isSomeType(finalLhsType) &&
      rhsType &&
      isSomeType(rhsType) &&
      rhsType.resolvedConcreteType
    ) {
      finalLhsType = {
        ...finalLhsType,
        resolvedConcreteType: rhsType.resolvedConcreteType,
      } as SomeType;
      lhs.$.type = finalLhsType;
    }

    // Under the new simplified ownership model:
    // All variables own their values
    // But we track shared ownership for dup/drop optimization
    // Find if RHS is sharing ownership with another variable
    const rhsOwningVariable = findRcValueOwnerRelationship(
      rhs,
      env,
      env.modulePath
    );

    // If the RHS owning variable was consumed (moved), then the LHS should become
    // the primary owner (isOwningTheSameRcValueAs: undefined), not a secondary reference.
    // This ensures ownership transfers completely on move.
    let isOwningTheSameRcValueAs = rhsOwningVariable;
    if (rhsOwningVariable?.consumedAtToken) {
      // The RHS was moved, so LHS becomes the new primary owner
      isOwningTheSameRcValueAs = undefined;
    }

    // Create new variable
    const { env: nextEnv } = addVariableToEnv({
      env,
      variable: {
        name: lhs.token.value,
        type: finalLhsType,
        isCompileTimeOnly,
        value: lhs.$.value ? [lhs.$.value] : undefined,
        token: lhs.token,
        initializedAtToken: lhs.token,
        consumedAtToken: undefined, // Not consumed yet
        // Under new ownership model: variables always own their values (or false for non-ARC types)
        isOwningTheRcValue: typeContainsRcType(finalLhsType),
        // Only set shared ownership for Copy types (shared references)
        // If RHS was moved, LHS becomes the primary owner
        isOwningTheSameRcValueAs,
        isReassignable: true, // This is not a function parameter
      },
    });
    env = nextEnv;

    lhs.$.env = env;
    expr.$ = {
      env,
      value: VUnit,
      type: VUnit.type,
      pathCollection: [],
    };
    return expr;
  } else {
    const { env: nextEnv, runtimeDestructurings } =
      evaluateDestructuringAssignment({
        lhs,
        rhs,
        env,
        isCompileTimeOnly,
        context: { ...context },
      });
    env = nextEnv;

    expr.$ = {
      env,
      value: VUnit,
      type: VUnit.type,
      pathCollection: [],
      runtimeDestructurings,
    };
    return expr;
  }
}
