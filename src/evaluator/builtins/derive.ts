/**
 * derive(Type, Trait1, Trait2, ...) — auto-generate trait implementations.
 *
 * Supported built-in traits: Eq, Hash, Clone, Ord, ToString.
 * Works on struct and enum types.
 *
 * Trait arguments can be:
 *   - TraitType values: Eq(Point), Hash, Clone (dispatched to built-in generators)
 *   - Comptime functions: fn(comptime(T) : Type) -> comptime(unit) (user-defined derives)
 *   - Bare trait names: Eq, Hash (backwards-compat, resolved to TraitType via env)
 *
 * Supports generic/where for generic types:
 *   derive(generic(T), Pair(T), where(T <: Eq(T)), Eq(Pair(T)))
 */

import type { Environment } from "../../env";
import {
  addVariableToEnv,
  pushEnvFrame,
  popEnvFrame,
  getVariablesFromEnv,
} from "../../env";
import { generateVarialeId } from "../../utils";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  type Expr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprIsAtom,
  type FnCallExpr,
  exprToString,
} from "../../expr";
import { generateExprFromCode } from "../../parser";
import type { EnumType, StructType, Type } from "../../types/definitions";
import { isEnumType, isStructType, isTraitType } from "../../types/guards";
import { typeToString } from "../../types/utils";
import {
  createExprValue,
  createTypeValue,
  createComptimeListValue,
  createUnknownValue,
  isExprValue,
  isTypeValue,
  isFunctionValue,
  type Value,
} from "../../value";
import type { FunctionValue } from "../../function-value";
import { VUnit } from "../../unit-value";
import { PlaceholderToken } from "../../token";
import { createExprType } from "../../types/creators";
import { createType0 } from "../../types/creators";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Entry point for `derive(Type, Trait1, Trait2, ...)`
 *
 * Argument layout (same positions as `impl`):
 *   derive([generic(...)], [where(...)], TargetType, [where(...)], Trait1, Trait2, ...)
 */
export function evaluateDerive({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  // In non-executing contexts (e.g., function body validation), return unit
  if (context.isValidatingFunctionDefinition || !context.isExecuting) {
    expr.$ = {
      env,
      type: VUnit.type,
      value: VUnit,
      pathCollection: [],
    };
    return expr;
  }

  if (expr.args.length < 2) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `derive requires at least 2 arguments: derive(Type, Trait1, ...). Got ${expr.args.length}.`,
    });
  }

  const args = expr.args;
  let argIndex = 0;
  let forallArg: FnCallExpr | undefined;
  let whereArg: FnCallExpr | undefined;

  // Check for generic(...)
  if (
    args[argIndex] &&
    exprIsFunctionCall(args[argIndex]!) &&
    exprIsFunctionCallOf(args[argIndex]!, BuiltinKeywords.generic)
  ) {
    forallArg = args[argIndex]! as FnCallExpr;
    argIndex++;

    // Introduce generic type variables into the env so that target type
    // expressions like Pair(A, B) can be evaluated
    env = pushEnvFrame(env);
    for (const paramExpr of forallArg.args) {
      let paramName: string;
      let paramTypeExpr: Expr | undefined;

      if (
        exprIsFunctionCall(paramExpr) &&
        exprIsFunctionCallOf(paramExpr, ":", 2)
      ) {
        const nameExpr = paramExpr.args[0]!;
        if (!exprIsAtom(nameExpr)) {
          throw formatErrorMessage({
            token: nameExpr.token,
            errorMessage: `Expected identifier for generic parameter name, got: ${exprToString(nameExpr)}`,
          });
        }
        paramName = nameExpr.token.value;
        paramTypeExpr = paramExpr.args[1]!;
      } else if (exprIsAtom(paramExpr)) {
        paramName = paramExpr.token.value;
      } else {
        throw formatErrorMessage({
          token: paramExpr.token,
          errorMessage: `Expected parameter name for generic parameter, got: ${exprToString(paramExpr)}`,
        });
      }

      // Evaluate optional type annotation
      let paramType: Type | undefined;
      if (paramTypeExpr) {
        const evaluatedType = evaluateExpression({
          expr: paramTypeExpr,
          env,
          context: { ...context },
        });
        if (evaluatedType.$?.env) {
          env = evaluatedType.$.env;
        }
        if (evaluatedType.$ && isTypeValue(evaluatedType.$.value)) {
          paramType = evaluatedType.$.value.value;
        }
      }

      const effectiveType = paramType || createType0();
      const unknownOrTypeValue = createUnknownValue(effectiveType, {
        variableName: paramName,
        env,
        context,
      });

      const { env: nextEnv } = addVariableToEnv({
        env,
        variable: {
          name: paramName,
          type: effectiveType,
          isCompileTimeOnly: true,
          value: [unknownOrTypeValue],
          token: paramExpr.token,
          initializedAtToken: paramExpr.token,
          consumedAtToken: undefined,
          isOwningTheRcValue: false,
        },
      });
      env = nextEnv;
    }
  }

  // Check for where(...) before target type
  if (
    args[argIndex] &&
    exprIsFunctionCall(args[argIndex]!) &&
    exprIsFunctionCallOf(args[argIndex]!, BuiltinKeywords.where)
  ) {
    if (!forallArg) {
      throw formatErrorMessage({
        token: args[argIndex]!.token,
        errorMessage: `derive where(...) requires generic(...).`,
      });
    }
    whereArg = args[argIndex]! as FnCallExpr;
    argIndex++;
  }

  // Evaluate the target type
  if (!args[argIndex]) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `derive requires a target type.`,
    });
  }

  // Save the target type expression BEFORE evaluating (for derive rules)
  const targetTypeExpr = args[argIndex]!;

  const typeArgExpr = evaluateExpression({
    expr: args[argIndex]!,
    env,
    context: { ...context },
  });

  if (!typeArgExpr.$ || !isTypeValue(typeArgExpr.$.value)) {
    throw formatErrorMessage({
      token: args[argIndex]!.token,
      errorMessage: `derive: expected a type, got:\n${exprToString(args[argIndex]!)}`,
    });
  }

  env = typeArgExpr.$.env;
  const targetType = typeArgExpr.$.value.value;
  argIndex++;

  // Check for where(...) after target type
  if (
    args[argIndex] &&
    exprIsFunctionCall(args[argIndex]!) &&
    exprIsFunctionCallOf(args[argIndex]!, BuiltinKeywords.where)
  ) {
    if (!forallArg) {
      throw formatErrorMessage({
        token: args[argIndex]!.token,
        errorMessage: `derive where(...) requires generic(...).`,
      });
    }
    if (whereArg) {
      throw formatErrorMessage({
        token: args[argIndex]!.token,
        errorMessage: `derive supports only a single where(...) clause.`,
      });
    }
    whereArg = args[argIndex]! as FnCallExpr;
    argIndex++;
  }

  if (!isStructType(targetType) && !isEnumType(targetType)) {
    throw formatErrorMessage({
      token: args[0]!.token,
      errorMessage: `derive only works on struct and enum types. Got: ${typeToString(targetType)}`,
    });
  }

  // Collect trait arguments (everything remaining)
  const traitArgs = args.slice(argIndex);
  if (traitArgs.length === 0) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `derive requires at least one trait argument after the target type.`,
    });
  }

  // Process each trait argument
  // Pop the generic env frame before processing trait args.
  // Each trait arg's processing will re-introduce generic vars as needed
  // (e.g., the generated impl(generic(A,B), ...) expression handles it).
  // We keep a reference to the env WITH generic vars for evaluating trait arg exprs.
  const envWithForall = env;
  if (forallArg) {
    env = popEnvFrame(env);
  }
  const envWithoutForall = env;

  for (const traitArgExpr of traitArgs) {
    env = processTraitArg({
      traitArgExpr,
      targetType,
      env: envWithoutForall,
      envForTraitEval: forallArg ? envWithForall : envWithoutForall,
      context,
      forallArg,
      whereArg,
      targetTypeExpr,
    });
  }

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };

  return expr;
}

/**
 * Process a single trait argument in derive().
 * The argument can be:
 *   1. A TraitType with a registered derive_rule — dispatch via rule
 *   2. A comptime function value — user-defined derive
 */
function processTraitArg({
  traitArgExpr,
  targetType,
  env,
  envForTraitEval,
  context,
  forallArg,
  whereArg,
  targetTypeExpr,
}: {
  traitArgExpr: Expr;
  targetType: StructType | EnumType;
  env: Environment;
  envForTraitEval: Environment;
  context: EvaluatorContext;
  forallArg?: FnCallExpr;
  whereArg?: FnCallExpr;
  targetTypeExpr: Expr;
}): Environment {
  // Evaluate the trait argument (use envForTraitEval which has generic vars in scope)
  const evaluated = evaluateExpression({
    expr: traitArgExpr,
    env: envForTraitEval,
    context: { ...context },
  });

  if (!evaluated.$) {
    throw formatErrorMessage({
      token: traitArgExpr.token,
      errorMessage: `derive: failed to evaluate trait argument: ${exprToString(traitArgExpr)}`,
    });
  }

  // Don't update env from evaluated.$.env — it comes from envForTraitEval
  // which may contain generic variables. Keep using env (without generic)
  // for impl generation, since the generated impl introduces its own generic.

  // Case 1: Evaluated to a TraitType → check registered rule, then built-in
  if (isTraitType(evaluated.$.type)) {
    const traitType = evaluated.$.type;

    // Check for registered derive rule on the trait type itself or its constructor
    const deriveRule =
      traitType.deriveRule ?? traitType.functionValue?.deriveRule;
    if (deriveRule) {
      // Extract trait constructor args from the call expression (e.g., MyEq(Point) → [Point])
      const traitParams = extractTraitParams(traitArgExpr);
      return callRegisteredDeriveRule({
        deriveRule,
        targetType,
        env,
        context,
        token: traitArgExpr.token,
        traitParams,
        forallArg,
        whereArg,
        targetTypeExpr,
      });
    }

    throw formatErrorMessage({
      token: traitArgExpr.token,
      errorMessage: `derive: trait '${typeToString(traitType)}' does not have a derive rule. Use derive_rule() to register one, or provide a derive function.`,
    });
  }

  // Case 2: TypeValue containing a TraitType (e.g., Hash evaluates to Type(Trait))
  if (isTypeValue(evaluated.$.value) && isTraitType(evaluated.$.value.value)) {
    const traitType = evaluated.$.value.value;

    const deriveRule =
      traitType.deriveRule ?? traitType.functionValue?.deriveRule;
    if (deriveRule) {
      const traitParams = extractTraitParams(traitArgExpr);
      return callRegisteredDeriveRule({
        deriveRule,
        targetType,
        env,
        context,
        token: traitArgExpr.token,
        traitParams,
        forallArg,
        whereArg,
        targetTypeExpr,
      });
    }

    throw formatErrorMessage({
      token: traitArgExpr.token,
      errorMessage: `derive: trait '${typeToString(traitType)}' does not have a derive rule. Use derive_rule() to register one, or provide a derive function.`,
    });
  }

  // Case 3: FunctionValue (bare trait fn like Eq without args) → check rule, then user-defined
  if (isFunctionValue(evaluated.$.value)) {
    const funcVal = evaluated.$.value;

    // Check for registered derive rule
    if (funcVal.deriveRule) {
      return callRegisteredDeriveRule({
        deriveRule: funcVal.deriveRule,
        targetType,
        env,
        context,
        token: traitArgExpr.token,
        traitParams: [],
        forallArg,
        whereArg,
        targetTypeExpr,
      });
    }

    // User-defined derive function: call it with the target type
    return callUserDerive({
      funcValue: funcVal,
      targetType,
      env,
      context,
      token: traitArgExpr.token,
    });
  }

  throw formatErrorMessage({
    token: traitArgExpr.token,
    errorMessage: `derive: expected a trait or derive function, got: ${exprToString(traitArgExpr)}`,
  });
}

/**
 * Call a user-defined derive function with the target type.
 */
function callUserDerive({
  funcValue,
  targetType,
  env,
  context,
  token,
}: {
  funcValue: FunctionValue;
  targetType: StructType | EnumType;
  env: Environment;
  context: EvaluatorContext;
  token: Expr["token"];
}): Environment {
  // Generate code to call the function: derive_fn(TargetType)
  const typeName = targetType.typeName ?? typeToString(targetType);
  const funcName = funcValue.funcName;

  if (!funcName) {
    throw formatErrorMessage({
      token,
      errorMessage: `derive: user-defined derive function must be a named function.`,
    });
  }

  const callCode = `${funcName}(${typeName})`;
  const callExpr = generateExprFromCode(callCode);

  const evaluated = evaluateExpression({
    expr: callExpr,
    env,
    context: {
      ...context,
      forceCompileTimeBindings: false,
    },
  });

  if (!evaluated.$) {
    throw formatErrorMessage({
      token,
      errorMessage: `derive: user-defined derive function failed:\n${callCode}`,
    });
  }

  return evaluated.$.env;
}

/**
 * Extract trait constructor arguments as raw Exprs from a call expression.
 * e.g., `MyEq(Point)` → [PointExpr]
 * For bare names like `MyEq`, returns [].
 */
function extractTraitParams(traitArgExpr: Expr): Expr[] {
  if (exprIsFunctionCall(traitArgExpr)) {
    const fnCall = traitArgExpr as FnCallExpr;
    return fnCall.args ?? [];
  }
  return [];
}

/**
 * Call a registered derive rule function.
 *
 * The derive rule has signature:
 *   fn(comptime(T) : Type, comptime(ctx) : DeriveContext, comptime(trait_params) : ComptimeList(Expr)) -> comptime(Expr)
 *
 * We construct:
 *   1. T = the target type value
 *   2. ctx = DeriveContext struct value (target, forall_params, where_clause)
 *   3. trait_params = ComptimeList(Expr) of the trait's type arguments
 *
 * Then call the function, get back an Expr, and evaluate it.
 */
function callRegisteredDeriveRule({
  deriveRule,
  targetType,
  env,
  context,
  token,
  traitParams,
  forallArg,
  whereArg,
  targetTypeExpr,
}: {
  deriveRule: FunctionValue;
  targetType: StructType | EnumType;
  env: Environment;
  context: EvaluatorContext;
  token: Expr["token"];
  traitParams: Expr[];
  forallArg?: FnCallExpr;
  whereArg?: FnCallExpr;
  targetTypeExpr: Expr;
}): Environment {
  // We need to bind values to temp variables and generate a call expression.
  env = pushEnvFrame(env);

  // 1. Bind the target type
  const typeVarName = `__derive_T_${generateVarialeId(env.modulePath, "dT")}`;
  const typeVal = createTypeValue(targetType);
  env = addComptimeVar(env, typeVarName, typeVal.type, typeVal);

  // 2. Bind the derive rule function with a unique name to avoid conflicts
  //    (the rule function may be defined in a different module scope)
  const ruleFnName = `__derive_rule_${generateVarialeId(env.modulePath, "dr")}`;
  env = addComptimeVar(env, ruleFnName, deriveRule.type, deriveRule);

  // 3. Create the target Expr value
  const targetExprVal = createExprValue(targetTypeExpr);
  const targetExprVarName = `__derive_te_${generateVarialeId(env.modulePath, "dte")}`;
  env = addComptimeVar(
    env,
    targetExprVarName,
    targetExprVal.type,
    targetExprVal
  );

  // 4. Create forall_params and where_clause as Option(Expr)
  const forallExprVarName = `__derive_fp_${generateVarialeId(env.modulePath, "dfp")}`;
  {
    const tmpName = `__derive_fp_tmp_${generateVarialeId(env.modulePath, "dfpt")}`;
    let optCode: string;
    if (forallArg) {
      const forallExprVal = createExprValue(forallArg);
      const optVarName = `__derive_fpe_${generateVarialeId(env.modulePath, "dfpe")}`;
      env = addComptimeVar(env, optVarName, forallExprVal.type, forallExprVal);
      optCode = `((${tmpName} : Option(Expr)) = .Some(${optVarName}))`;
    } else {
      optCode = `((${tmpName} : Option(Expr)) = .None)`;
    }
    const optExpr = generateExprFromCode(optCode);
    const optResult = evaluateExpression({
      expr: optExpr,
      env,
      context: { ...context, forceCompileTimeBindings: true },
    });
    if (optResult.$) {
      env = optResult.$.env;
      const vars = getVariablesFromEnv(env, tmpName);
      const optVar = vars[vars.length - 1];
      if (optVar && optVar.value && optVar.value[0]) {
        env = addComptimeVar(
          env,
          forallExprVarName,
          optVar.type,
          optVar.value[0]
        );
      }
    }
  }

  const whereExprVarName = `__derive_wp_${generateVarialeId(env.modulePath, "dwp")}`;
  {
    const tmpName = `__derive_wp_tmp_${generateVarialeId(env.modulePath, "dwpt")}`;
    let optCode: string;
    if (whereArg) {
      const whereExprVal = createExprValue(whereArg);
      const optVarName = `__derive_wpe_${generateVarialeId(env.modulePath, "dwpe")}`;
      env = addComptimeVar(env, optVarName, whereExprVal.type, whereExprVal);
      optCode = `((${tmpName} : Option(Expr)) = .Some(${optVarName}))`;
    } else {
      optCode = `((${tmpName} : Option(Expr)) = .None)`;
    }
    const optExpr = generateExprFromCode(optCode);
    const optResult = evaluateExpression({
      expr: optExpr,
      env,
      context: { ...context, forceCompileTimeBindings: true },
    });
    if (optResult.$) {
      env = optResult.$.env;
      const vars = getVariablesFromEnv(env, tmpName);
      const optVar = vars[vars.length - 1];
      if (optVar && optVar.value && optVar.value[0]) {
        env = addComptimeVar(
          env,
          whereExprVarName,
          optVar.type,
          optVar.value[0]
        );
      }
    }
  }

  // 5. Create DeriveContext
  const ctxVarName = `__derive_ctx_${generateVarialeId(env.modulePath, "dctx")}`;
  const ctxCode = `DeriveContext(${targetExprVarName}, ${forallExprVarName}, ${whereExprVarName})`;
  const ctxExpr = generateExprFromCode(ctxCode);
  const ctxResult = evaluateExpression({
    expr: ctxExpr,
    env,
    context: { ...context, forceCompileTimeBindings: true },
  });

  if (!ctxResult.$ || !ctxResult.$.value) {
    throw formatErrorMessage({
      token,
      errorMessage: `derive: failed to create DeriveContext`,
    });
  }
  env = ctxResult.$.env;
  env = addComptimeVar(env, ctxVarName, ctxResult.$.type, ctxResult.$.value);

  // 6. Create trait_params as quoted Exprs
  // For each trait param, quote it and add to a temp list
  const paramVarNames: string[] = [];
  for (let i = 0; i < traitParams.length; i++) {
    const paramExprVal = createExprValue(traitParams[i]!);
    const pvName = `__derive_tp_${generateVarialeId(env.modulePath, "dtp")}`;
    env = addComptimeVar(env, pvName, paramExprVal.type, paramExprVal);
    paramVarNames.push(pvName);
  }

  // Build ComptimeList(Expr) from params
  const traitParamsVarName = `__derive_tps_${generateVarialeId(env.modulePath, "dtps")}`;
  if (paramVarNames.length > 0) {
    const listCode = `comptime_list(${paramVarNames.join(", ")})`;
    const listExpr = generateExprFromCode(listCode);
    const listResult = evaluateExpression({
      expr: listExpr,
      env,
      context: { ...context, forceCompileTimeBindings: true },
    });

    if (!listResult.$ || !listResult.$.value) {
      throw formatErrorMessage({
        token,
        errorMessage: `derive: failed to create trait params list`,
      });
    }
    env = listResult.$.env;
    env = addComptimeVar(
      env,
      traitParamsVarName,
      listResult.$.type,
      listResult.$.value
    );
  } else {
    // Empty list — create directly via TypeScript
    const exprType = createExprType();
    const emptyList = createComptimeListValue(exprType, []);
    env = addComptimeVar(env, traitParamsVarName, emptyList.type, emptyList);
  }

  // 7. Call the derive rule function
  const callCode = `${ruleFnName}(${typeVarName}, ${ctxVarName}, ${traitParamsVarName})`;
  const callExpr = generateExprFromCode(callCode);
  const callResult = evaluateExpression({
    expr: callExpr,
    env,
    context: { ...context, forceCompileTimeBindings: true },
  });

  if (!callResult.$ || !callResult.$.value) {
    throw formatErrorMessage({
      token,
      errorMessage: `derive: derive rule function failed`,
    });
  }
  env = callResult.$.env;

  // The result should be an Expr — evaluate it
  if (!isExprValue(callResult.$.value)) {
    throw formatErrorMessage({
      token,
      errorMessage: `derive: derive rule must return comptime(Expr), got something else`,
    });
  }

  const resultExpr = callResult.$.value.value;

  // Pop the temp frame
  env = popEnvFrame(env, true);

  // Evaluate the returned Expr in the original env
  const implResult = evaluateExpression({
    expr: resultExpr,
    env,
    context: { ...context, forceCompileTimeBindings: false },
  });

  if (!implResult.$) {
    throw formatErrorMessage({
      token,
      errorMessage: `derive: failed to evaluate derive rule output`,
    });
  }

  return implResult.$.env;
}

/**
 * Helper: add a comptime-only variable to the env.
 */
function addComptimeVar(
  env: Environment,
  name: string,
  type: Type,
  value: Value
): Environment {
  const result = addVariableToEnv({
    env,
    variable: {
      name,
      type,
      value: [value],
      isCompileTimeOnly: true,
      isOwningTheRcValue: false,
      initializedAtToken: PlaceholderToken,
      consumedAtToken: undefined,
      token: PlaceholderToken,
    },
  });
  return result.env;
}
