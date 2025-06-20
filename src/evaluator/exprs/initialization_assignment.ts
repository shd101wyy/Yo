import { checkBorrowings } from "../../borrow";
import { addVariableToEnv, Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
  setExprAsConsumed,
} from "../../expr";
import {
  areTypesCompatible,
  convertComptTypeToRuntimeType,
  isFreeType,
  isLinearType,
  typeContainsReference,
  typeOfType,
  typeRequiresComptModifier,
  typeToString,
} from "../../type-checker";
import { setTypeValueAsLinear } from "../../type-value";
import { VUnit } from "../../unit-value";
import {
  createUnknownValue,
  isFunctionValue,
  isModuleValue,
  isTypeValue,
} from "../../value";
import { EvaluatorContext } from "../context";
import { synthesizeExprAndType } from "../types/synthesizer";
import { isValidVariableName } from "../utils";
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
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (
    !exprIsFunctionCallOf(expr, ":=", 2) &&
    !exprIsFunctionCallOf(expr, "::", 2)
  ) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected ":=" or "::" for initialization assignment.`,
    });
  }
  const isCompileTimeOnly = exprIsFunctionCallOf(expr, "::");
  let isMutable = false;
  let isImplicit = false;

  let lhs = expr.args[0]!;
  let rhs = expr.args[1]!;

  // Check if the variale is implicit
  if (
    exprIsFunctionCall(lhs) &&
    exprIsFunctionCallOf(lhs, BuiltinKeywords.implicit)
  ) {
    isImplicit = true;
    // Check if the lhs is a variable
    if (lhs.args.length !== 1) {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Expected one argument for implicit, got ${lhs.args.length}`,
      });
    }
    lhs = lhs.args[0]!;
  }

  // Check if the variable is mutable
  if (
    exprIsFunctionCall(lhs) &&
    exprIsFunctionCallOf(lhs, BuiltinKeywords.mut)
  ) {
    isMutable = true;
    // Check if the lhs is a variable
    if (lhs.args.length !== 1) {
      throw formatErrorMessage({
        token: lhs.token,
        errorMessage: `Expected one argument for mut, got ${lhs.args.length}`,
      });
    }
    lhs = lhs.args[0]!;
  }

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
  rhs = context.evaluateExpression({
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

  // Set the rhs as consumed
  env = setExprAsConsumed(rhs, env);

  // If rhs is type value, then it cannot be mutable
  if (isTypeValue(rhs.$?.value) && isMutable) {
    throw formatErrorMessage({
      token: lhs.token,
      errorMessage: `Unexpected "mut" (or "!") for type value:
${exprToString(rhs)}`,
    });
  }

  if (exprIsAtom(lhs)) {
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
      // compt_int -> i32
      // compt_float -> f64
      // etc...
      let lhsType = rhsType;
      if (!isCompileTimeOnly) {
        lhsType = convertComptTypeToRuntimeType(rhsType);
      }

      // user didn't specify the type
      lhs.$ = {
        env,
        type: lhsType,
        isMutable,
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
        !areTypesCompatible({ type: lhs.$?.type, env }, { type: rhsType, env })
      ) {
        throw formatErrorMessage({
          token: lhs.token,
          errorMessage: `Incompatible types:
- Defined: ${typeToString(lhs.$?.type)}
- Given  : ${typeToString(rhsType)}`,
        });
      }
    }

    // Check some value that requires compile-time only
    if (!isCompileTimeOnly && typeRequiresComptModifier(lhs.$.type)) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Expected "::" instead of ":=" for compile-time known value assignment:
${exprToString(expr)}`,
      });
    }

    // Check if the rhsType contains reference
    if (typeContainsReference(rhsType)) {
      throw formatErrorMessage({
        token: rhs.token,
        errorMessage: `Assigning reference to variable is not allowed.`,
      });
    }

    // Check the borrowings
    checkBorrowings(context.borrowings, rhs);

    // Add .typeName info if necessary
    let rhsValue = rhs.$?.value;
    if (
      isTypeValue(rhsValue) &&
      /*
        (isStructType(rhsValue.value) ||
          isEnumType(rhsValue.value) ||
          isUnionType(rhsValue.value) ||
          isModuleType(rhsValue.value)) &&
        */
      !rhsValue.value.typeName
    ) {
      rhsValue.value.typeName = lhs.token.value;
    } else if (isFunctionValue(rhsValue) && !rhsValue.funcName) {
      rhsValue.funcName = lhs.token.value;
    } else if (isModuleValue(rhsValue) && !rhsValue.type.typeName) {
      rhsValue.type.typeName = lhs.token.value;
    }

    // Check if it's assigning Free to Linear
    if (
      isTypeValue(rhsValue) &&
      isFreeType(typeOfType(rhsValue.value)) &&
      isLinearType(lhs.$.type)
    ) {
      rhsValue = setTypeValueAsLinear(rhsValue);
    }

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
    lhs.$ = {
      env,
      type: lhs.$.type,
      value: isCompileTimeOnly
        ? (rhsValue ?? createUnknownValue(lhs.$.type, lhs.token.value))
        : undefined,
      isMutable,
      pathCollection: [],
    };

    // Add variable to env
    // Attach the updated env to expr
    // console.log("(6) addVariableToEnv");
    const { env: nextEnv } = addVariableToEnv({
      env,
      variable: {
        name: lhs.token.value,
        token: lhs.token,
        type: lhs.$.type,
        isMutable,
        isCompileTimeOnly,
        isUndefined: false,
        isImplicit,
        value: lhs.$.value,
      },
    });
    env = nextEnv;

    lhs.$.env = env;
    expr.$ = {
      env,
      value: VUnit,
      type: VUnit.type,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  } else {
    // Evaluate the destructuring assignment
    if (!rhs.$) {
      throw formatErrorMessage({
        token: rhs.token,
        errorMessage: `Failed to evaluate the right-hand side expression:
${exprToString(rhs)}`,
      });
    }
    env = evaluateDestructuringAssignment({
      lhs,
      rhs,
      env,
      isCompileTimeOnly,
      context: { ...context },
    });

    // NOTE: rhs is already set as consumed above

    expr.$ = {
      env,
      value: VUnit,
      type: VUnit.type,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  }
}
