import { addVariableToEnv, Environment, pushEnvFrame } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
  mergeAndCheckEnvs,
  setExprAsConsumed,
} from "../../expr";
import {
  areTypesCompatible,
  convertComptTypeToRuntimeType,
  createMutPtrType,
  createMutRefType,
  createPtrType,
  createRefType,
  EnumType,
  isEnumType,
  isMutPtrType,
  isMutRefType,
  isPtrType,
  isRefType,
  MutPtrType,
  MutRefType,
  PtrType,
  RefType,
  Type,
  TypeTag,
  typeToString,
} from "../../type-checker";
import { EvaluatorContext } from "../context";
import { isValidVariableName } from "../utils";

/**
 *
 *
 * match shape // shape will be consumed here and moved to `s` in each condition.
 *   .Circle => ((s) => s.radius),
 *   .Square => ((s) => s.side),
 *   .Rectangle => ((s) => s.width + s.height)
 * ;
 */
export function evaluateMatch({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.match)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "match", got ${expr.tag}`,
    });
  }

  const args = expr.args;
  if (args.length < 2) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected at least 2 arguments for "match", got ${args.length}`,
    });
  }

  // Evaluate the value to be matched
  const valueExpr = args[0]!;
  const evaluatedMatchValue = context.evaluateExpression({
    expr: valueExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedMatchValue.$) {
    throw formatErrorMessage({
      token: valueExpr.token,
      errorMessage: `Failed to evaluate the match value expression: ${exprToString(valueExpr)}`,
    });
  }
  env = evaluatedMatchValue.$.env;

  // Consume the value expression
  env = setExprAsConsumed(evaluatedMatchValue, env);

  const matchValueType = evaluatedMatchValue.$.type;

  // Check if it's a pointer/reference type
  // If yes, then automatically dereference one-level of it.
  let ptrOrRefType:
    | TypeTag.Ptr
    | TypeTag.MutPtr
    | TypeTag.Ref
    | TypeTag.MutRef
    | undefined = undefined;

  let enumType: Type;

  if (
    isPtrType(matchValueType) ||
    isMutPtrType(matchValueType) ||
    isRefType(matchValueType) ||
    isMutRefType(matchValueType)
  ) {
    enumType = matchValueType.type;
    ptrOrRefType = matchValueType.tag;
  } else {
    enumType = matchValueType;
  }

  // Check if the value is an enum type
  if (!isEnumType(enumType)) {
    throw formatErrorMessage({
      token: valueExpr.token,
      errorMessage: `Expected enum type for match expression, got ${
        matchValueType ? typeToString(matchValueType) : "unknown type"
      }`,
    });
  }

  // Check if there is already selected variant,
  // If yes, then we disallow to use enum because we already know the selected variant.
  if (enumType.selectedVariantName) {
    throw formatErrorMessage({
      token: valueExpr.token,
      errorMessage:
        `Enum type ${typeToString(enumType)} already has selected variant "${enumType.selectedVariantName}".\n` +
        `You cannot use "match" on it, because it already has a selected variant.`,
    });
  }

  const patterns = args.slice(1);

  // Evaluate each statement
  // expect each value to be the same type.
  const bodies: Expr[] = [];
  let resultType: { type: Type; env: Environment } | undefined = undefined;
  const checkedVariantNames: Set<string> = new Set();

  for (let i = 0; i < patterns.length; i++) {
    const pattern = patterns[i]!;

    // NOTE: We shouldn't use the parent `env` here
    // instead, we should create new env.
    let caseEnv = pushEnvFrame(env);

    // Check if the pattern is a valid match arm
    if (
      !exprIsFunctionCall(pattern) ||
      !exprIsFunctionCallOf(pattern, "=>", 2)
    ) {
      throw formatErrorMessage({
        token: pattern.token,
        errorMessage: `Expected ":" for match pattern, got ${exprToString(pattern)}`,
      });
    }

    const patternExpr = pattern.args[0]!;
    const rhsExpr = pattern.args[1]!;

    // Check if the pattern is a valid enum variant
    if (
      exprIsFunctionCall(patternExpr) &&
      exprIsFunctionCallOf(patternExpr, ".", 1)
    ) {
      // For patterns like .Red
      const variantNameExpr = patternExpr.args[0]!;
      if (!exprIsAtom(variantNameExpr)) {
        throw formatErrorMessage({
          token: patternExpr.token,
          errorMessage: `Expected identifier for enum variant, got ${exprToString(
            variantNameExpr
          )}`,
        });
      }

      const variantName = variantNameExpr.token.value;
      // Check if variant exists in enum
      const variant = enumType.variants.find((v) => v.name === variantName);
      if (!variant) {
        throw formatErrorMessage({
          token: patternExpr.token,
          errorMessage: `Enum variant "${variantName}" not found in ${typeToString(
            enumType
          )}`,
        });
      }
      checkedVariantNames.add(variantName);
      if (
        enumType.selectedVariantName &&
        enumType.selectedVariantName !== variantName
      ) {
        continue; // No need to continue if the variant is not selected
      }

      let bodyExpr: Expr;
      // Update the enum type to set the selectedVariantName
      const newEnumType = {
        ...enumType,
        selectedVariantName: variantName,
      };
      let variableType: EnumType | PtrType | MutPtrType | RefType | MutRefType =
        newEnumType;
      if (ptrOrRefType) {
        if (ptrOrRefType === TypeTag.Ptr) {
          variableType = createPtrType(newEnumType);
        } else if (ptrOrRefType === TypeTag.MutPtr) {
          variableType = createMutPtrType(newEnumType);
        } else if (ptrOrRefType === TypeTag.Ref) {
          variableType = createRefType(newEnumType);
        } else if (ptrOrRefType === TypeTag.MutRef) {
          variableType = createMutRefType(newEnumType);
        }
      }

      // Create a new environment for the case
      //   .VariantName => ((variable) => body)
      if (
        exprIsFunctionCall(rhsExpr) &&
        exprIsFunctionCallOf(rhsExpr, "=>", 2)
      ) {
        const variableExpr = rhsExpr.args[0]!;
        bodyExpr = rhsExpr.args[1]!;

        if (!isValidVariableName(variableExpr)) {
          throw formatErrorMessage({
            token: variableExpr.token,
            errorMessage: `Invalid variable name in match arm: ${variableExpr.token.value}`,
          });
        }

        const variableName = variableExpr.token.value;

        // Add the new variable to env
        const { env: nextEnv } = addVariableToEnv({
          env: caseEnv,
          variable: {
            name: variableName,
            type: variableType,
            isMutable: evaluatedMatchValue.$.isMutable,
            isCompileTimeOnly: false,
            isImplicit: false,
            value: evaluatedMatchValue.$.value,
            token: variableExpr.token,
            initializedAtToken: variableExpr.token, // Set as initialized
            consumedAtToken: undefined,
          },
        });
        caseEnv = nextEnv;

        // Add information to variableExpr
        variableExpr.$ = {
          env: caseEnv,
          type: variableType,
          value: evaluatedMatchValue.$.value,
          isMutable: evaluatedMatchValue.$.isMutable,
          pathCollection: [[variableName]],
        };
      }
      //   .VariantName => body;
      //  this is for case like:
      //
      //  match color // < color here is a valid variable name
      //    .Red => {
      //       another_color := color; // we can use the "new" `color` here.
      //    },
      else {
        bodyExpr = rhsExpr;

        if (isValidVariableName(evaluatedMatchValue)) {
          const variableName = evaluatedMatchValue.token.value;

          // Add the new variable to env
          const { env: nextEnv } = addVariableToEnv({
            env: caseEnv,
            variable: {
              name: variableName,
              type: variableType,
              isMutable: evaluatedMatchValue.$.isMutable,
              isCompileTimeOnly: false,
              isImplicit: false,
              value: evaluatedMatchValue.$.value,
              token: evaluatedMatchValue.token,
              initializedAtToken: evaluatedMatchValue.token, // Set as initialized
              consumedAtToken: undefined, // Not consumed yet
            },
          });
          caseEnv = nextEnv;
        }
      }

      // Evaluate the result expression
      const evaluatedResult = context.evaluateExpression({
        expr: bodyExpr,
        env: caseEnv,
        context: {
          ...context,
        },
      });
      // We don't update the original env here since each pattern has its own scope

      if (!evaluatedResult.$?.type) {
        throw formatErrorMessage({
          token: bodyExpr.token,
          errorMessage: `Expected type for match result expression, got ${exprToString(
            bodyExpr
          )}`,
        });
      }
      caseEnv = evaluatedResult.$.env;
      bodies.push(evaluatedResult);

      // Set or verify the result type consistency
      if (!resultType) {
        resultType = { type: evaluatedResult.$?.type, env: caseEnv };
      } else if (
        !areTypesCompatible(
          { type: resultType.type, env: caseEnv },
          { type: evaluatedResult.$?.type, env }
        )
      ) {
        // Check if the types match when converting to runtime type
        if (
          areTypesCompatible(
            {
              type: convertComptTypeToRuntimeType(resultType.type),
              env: resultType.env,
            },
            {
              type: evaluatedResult.$.type,
              env: caseEnv,
            }
          )
        ) {
          resultType = { type: evaluatedResult.$.type, env: caseEnv };
        } else {
          throw formatErrorMessage({
            token: valueExpr.token,
            errorMessage: `Incompatible types:
- Previous: ${typeToString(resultType.type)}
- Current : ${typeToString(evaluatedResult.$.type)}`,
          });
        }
      }
    }
    // For patterns with destructuring like Shape.Circle(r)
    // NOTE: This is no longer supported
    else if (
      exprIsFunctionCall(patternExpr) &&
      exprIsFunctionCall(patternExpr.func) &&
      exprIsFunctionCallOf(patternExpr.func, ".", 1)
    ) {
      throw formatErrorMessage({
        token: patternExpr.token,
        errorMessage: `Destructuring enum variant elements is not supported in match expressions.
Please use .variantName for destructuring enum variants,
then destructure the value in the case body expression.`,
      });
    } else {
      throw formatErrorMessage({
        token: patternExpr.token,
        errorMessage: `Invalid pattern in match expression: ${exprToString(patternExpr)}
Please use .variantName for destructuring enum variants.`,
      });
    }
  }

  if (!resultType) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Could not determine result type for match expression`,
    });
  }

  // Perform exhaustiveness check
  const missingVariants = enumType.variants.filter(
    (variant) => !checkedVariantNames.has(variant.name)
  );
  if (missingVariants.length > 0) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Match expression is not exhaustive. Missing cases for variants:
        
- ${missingVariants.map((v) => v.name).join("\n- ")}`,
    });
  }

  // Merge and check all environments
  env = mergeAndCheckEnvs(env, bodies);

  // Set the type and value of the match expression
  expr.$ = {
    env,
    type: resultType.type,
    // TODO: Support the compile-time value.
    // For compile-time evaluation, we'd determine which arm matches and set the value
    value: undefined, // createUnknownValue(resultType),
    isMutable: false,
    pathCollection: [],
  };

  return expr;
}
