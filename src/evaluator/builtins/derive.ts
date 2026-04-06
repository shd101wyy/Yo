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
 * Supports forall/where for generic types:
 *   derive(forall(T), Pair(T), where(T <: Eq(T)), Eq(Pair(T)))
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
import type {
  EnumType,
  EnumVariant,
  StructType,
  TraitType,
  Type,
  TypeField,
} from "../../types/definitions";
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
import { typeImplementsTrait } from "../trait-checking";

type DerivableTraitName = "Eq" | "Hash" | "Clone" | "Ord" | "ToString";

const DERIVABLE_TRAITS: ReadonlySet<string> = new Set([
  "Eq",
  "Hash",
  "Clone",
  "Ord",
  "ToString",
]);

/**
 * Entry point for `derive(Type, Trait1, Trait2, ...)`
 *
 * Argument layout (same positions as `impl`):
 *   derive([forall(...)], [where(...)], TargetType, [where(...)], Trait1, Trait2, ...)
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

  // Check for forall(...)
  if (
    args[argIndex] &&
    exprIsFunctionCall(args[argIndex]!) &&
    exprIsFunctionCallOf(args[argIndex]!, BuiltinKeywords.forall)
  ) {
    forallArg = args[argIndex]! as FnCallExpr;
    argIndex++;

    // Introduce forall type variables into the env so that target type
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
            errorMessage: `Expected identifier for forall parameter name, got: ${exprToString(nameExpr)}`,
          });
        }
        paramName = nameExpr.token.value;
        paramTypeExpr = paramExpr.args[1]!;
      } else if (exprIsAtom(paramExpr)) {
        paramName = paramExpr.token.value;
      } else {
        throw formatErrorMessage({
          token: paramExpr.token,
          errorMessage: `Expected parameter name for forall parameter, got: ${exprToString(paramExpr)}`,
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
        errorMessage: `derive where(...) requires forall(...).`,
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
        errorMessage: `derive where(...) requires forall(...).`,
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

  const typeName = getTypeName(targetType);
  if (!typeName) {
    throw formatErrorMessage({
      token: args[0]!.token,
      errorMessage: `derive: could not determine name for type ${typeToString(targetType)}`,
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

  // Build forall/where prefix/suffix for generated impl code
  const forallPrefix = forallArg ? exprToString(forallArg) + ", " : "";
  const whereSuffix = whereArg ? ", " + exprToString(whereArg) : "";
  const hasForall = !!forallArg;

  // Process each trait argument
  // Pop the forall env frame before processing trait args.
  // Each trait arg's processing will re-introduce forall vars as needed
  // (e.g., the generated impl(forall(A,B), ...) expression handles it).
  // We keep a reference to the env WITH forall vars for evaluating trait arg exprs.
  const envWithForall = env;
  if (forallArg) {
    env = popEnvFrame(env);
  }
  const envWithoutForall = env;

  for (const traitArgExpr of traitArgs) {
    env = processTraitArg({
      traitArgExpr,
      targetType,
      typeName,
      env: envWithoutForall,
      envForTraitEval: forallArg ? envWithForall : envWithoutForall,
      context,
      forallPrefix,
      whereSuffix,
      hasForall,
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
 *   1. A bare trait name (Eq, Hash, etc.) — backwards compat
 *   2. An evaluated TraitType (Eq(Point), Hash, Clone) — dispatch by typeName
 *   3. A comptime function value — user-defined derive
 */
function processTraitArg({
  traitArgExpr,
  targetType,
  typeName,
  env,
  envForTraitEval,
  context,
  forallPrefix,
  whereSuffix,
  hasForall,
  forallArg,
  whereArg,
  targetTypeExpr,
}: {
  traitArgExpr: Expr;
  targetType: StructType | EnumType;
  typeName: string;
  env: Environment;
  envForTraitEval: Environment;
  context: EvaluatorContext;
  forallPrefix: string;
  whereSuffix: string;
  hasForall: boolean;
  forallArg?: FnCallExpr;
  whereArg?: FnCallExpr;
  targetTypeExpr: Expr;
}): Environment {
  // Evaluate the trait argument (use envForTraitEval which has forall vars in scope)
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
  // which may contain forall variables. Keep using env (without forall)
  // for impl generation, since the generated impl introduces its own forall.

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

    const traitName = getBaseTraitName(traitType);
    if (traitName && DERIVABLE_TRAITS.has(traitName)) {
      return deriveTraitForType({
        traitName: traitName as DerivableTraitName,
        targetType,
        typeName,
        env,
        context,
        token: traitArgExpr.token,
        forallPrefix,
        whereSuffix,
        hasForall,
      });
    }

    throw formatErrorMessage({
      token: traitArgExpr.token,
      errorMessage: `derive: trait '${traitName ?? typeToString(traitType)}' does not have a derive rule. Use derive_rule() to register one, or provide a derive function.`,
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

    const traitName = getBaseTraitName(traitType);
    if (traitName && DERIVABLE_TRAITS.has(traitName)) {
      return deriveTraitForType({
        traitName: traitName as DerivableTraitName,
        targetType,
        typeName,
        env,
        context,
        token: traitArgExpr.token,
        forallPrefix,
        whereSuffix,
        hasForall,
      });
    }

    throw formatErrorMessage({
      token: traitArgExpr.token,
      errorMessage: `derive: trait '${traitName ?? typeToString(traitType)}' does not have a derive rule. Use derive_rule() to register one, or provide a derive function.`,
    });
  }

  // Case 3: FunctionValue (bare trait fn like Eq without args) → check rule, then built-in, then user-defined
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

    const funcName = funcVal.funcName;

    // Built-in parameterized traits (Eq, Ord) require explicit type args
    if (funcName && DERIVABLE_TRAITS.has(funcName)) {
      throw formatErrorMessage({
        token: traitArgExpr.token,
        errorMessage: `derive: '${funcName}' requires explicit type arguments. Use '${funcName}(${typeName})' instead of bare '${funcName}'.`,
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

  // 2. Bind the derive rule function
  const ruleFnName =
    deriveRule.funcName ??
    `__derive_rule_${generateVarialeId(env.modulePath, "dr")}`;
  // Only bind if not already accessible by name
  if (!deriveRule.funcName) {
    env = addComptimeVar(env, ruleFnName, deriveRule.type, deriveRule);
  }

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
function getTypeName(type: StructType | EnumType): string | undefined {
  return type.typeName;
}

/**
 * Extract the base trait name from a TraitType.
 * For `Eq(Point)`, typeName is "Eq(Point)" but we need "Eq".
 * Falls back to functionValue.funcName, then typeName without parens.
 */
function getBaseTraitName(traitType: TraitType): string | undefined {
  // Try functionValue.funcName first (most reliable for specialized traits)
  if (traitType.functionValue?.funcName) {
    return traitType.functionValue.funcName;
  }
  // Fall back to typeName, stripping any type args
  const name = traitType.typeName;
  if (!name) return undefined;
  const parenIdx = name.indexOf("(");
  return parenIdx >= 0 ? name.slice(0, parenIdx) : name;
}

/**
 * Dispatch to the appropriate derive function for a trait.
 */
function deriveTraitForType({
  traitName,
  targetType,
  typeName,
  env,
  context,
  token,
  forallPrefix,
  whereSuffix,
  hasForall,
}: {
  traitName: DerivableTraitName;
  targetType: StructType | EnumType;
  typeName: string;
  env: Environment;
  context: EvaluatorContext;
  token: Expr["token"];
  forallPrefix: string;
  whereSuffix: string;
  hasForall: boolean;
}): Environment {
  if (isStructType(targetType)) {
    return deriveTraitForStruct({
      traitName,
      structType: targetType,
      typeName,
      env,
      context,
      token,
      forallPrefix,
      whereSuffix,
      hasForall,
    });
  } else {
    return deriveTraitForEnum({
      traitName,
      enumType: targetType,
      typeName,
      env,
      context,
      token,
      forallPrefix,
      whereSuffix,
      hasForall,
    });
  }
}

// ============================================================
// Struct derives
// ============================================================

function deriveTraitForStruct({
  traitName,
  structType,
  typeName,
  env,
  context,
  token,
  forallPrefix,
  whereSuffix,
  hasForall,
}: {
  traitName: DerivableTraitName;
  structType: StructType;
  typeName: string;
  env: Environment;
  context: EvaluatorContext;
  token: Expr["token"];
  forallPrefix: string;
  whereSuffix: string;
  hasForall: boolean;
}): Environment {
  const fields = structType.fields;

  // Skip field-level validation when forall is present — where constraints handle it
  if (!hasForall) {
    switch (traitName) {
      case "Eq":
        validateFieldsImplementTrait(
          fields,
          "Eq",
          typeName,
          env,
          context,
          token
        );
        break;
      case "Hash":
        validateFieldsImplementTrait(
          fields,
          "Hash",
          typeName,
          env,
          context,
          token
        );
        break;
      case "Clone":
        validateFieldsImplementTrait(
          fields,
          "Clone",
          typeName,
          env,
          context,
          token
        );
        break;
      case "Ord":
        validateFieldsImplementTrait(
          fields,
          "Eq",
          typeName,
          env,
          context,
          token
        );
        validateFieldsImplementTrait(
          fields,
          "Ord",
          typeName,
          env,
          context,
          token
        );
        break;
      case "ToString":
        validateFieldsImplementTrait(
          fields,
          "ToString",
          typeName,
          env,
          context,
          token
        );
        break;
    }
  }

  const code = generateImplCodeForTrait(
    traitName,
    typeName,
    fields,
    undefined,
    forallPrefix,
    whereSuffix
  );
  return evalImplCode(code, structType, env, context, token);
}

/**
 * Validate that all fields of a struct implement a given trait.
 */
function validateFieldsImplementTrait(
  fields: TypeField[],
  traitName: string,
  typeName: string,
  env: Environment,
  context: EvaluatorContext,
  token: Expr["token"]
): void {
  for (const field of fields) {
    const traitType = resolveTraitTypeFromEnv(
      traitName,
      field.type,
      env,
      context
    );
    if (
      traitType &&
      !typeImplementsTrait({ targetType: field.type, traitType, env })
    ) {
      throw formatErrorMessage({
        token,
        errorMessage: `Cannot derive ${traitName} for ${typeName}: field '${field.label}' of type ${typeToString(field.type)} does not implement ${traitName}`,
      });
    }
  }
}

/**
 * Resolve a trait type from the environment, applying the field type as parameter
 * if the trait takes one (e.g., Eq(FieldType), Ord(FieldType)).
 */
function resolveTraitTypeFromEnv(
  traitName: string,
  fieldType: Type,
  env: Environment,
  context: EvaluatorContext
): TraitType | undefined {
  // For Eq and Ord, the trait takes a type parameter: Eq(FieldType)
  // For Hash, Clone, ToString, no type parameter
  const needsTypeParam = traitName === "Eq" || traitName === "Ord";

  const code = needsTypeParam
    ? `${traitName}(${typeToString(fieldType)})`
    : `${traitName}()`;

  try {
    const traitExpr = generateExprFromCode(code);
    const evaluated = evaluateExpression({
      expr: traitExpr,
      env,
      context: {
        ...context,
        isValidatingFunctionDefinition: false,
      },
    });

    if (
      evaluated.$ &&
      isTypeValue(evaluated.$.value) &&
      isTraitType(evaluated.$.value.value)
    ) {
      return evaluated.$.value.value;
    }
    if (evaluated.$ && isTraitType(evaluated.$.type)) {
      return evaluated.$.type;
    }
  } catch {
    // If the trait can't be resolved, skip validation
  }

  return undefined;
}

/**
 * Evaluate an impl code string in the context of a type.
 */
function evalImplCode(
  code: string,
  targetType: StructType | EnumType,
  env: Environment,
  context: EvaluatorContext,
  token: Expr["token"]
): Environment {
  const implExpr = generateExprFromCode(code);

  const evaluatedExpr = evaluateExpression({
    expr: implExpr,
    env,
    context: {
      ...context,
      SelfType: targetType,
      forceCompileTimeBindings: false,
    },
  });

  if (!evaluatedExpr.$) {
    throw formatErrorMessage({
      token,
      errorMessage: `derive: failed to evaluate generated impl:\n${code}`,
    });
  }

  return evaluatedExpr.$.env;
}

/**
 * Generate impl code for a trait, wrapping with forall/where if present.
 * The struct generators produce: `impl(TypeName, TraitExpr(...))`
 * With forall/where, they become: `impl(forall(...), TypeName, where(...), TraitExpr(...))`
 */
function generateImplCodeForTrait(
  traitName: DerivableTraitName,
  typeName: string,
  fields: TypeField[] | undefined,
  variants: EnumVariant[] | undefined,
  forallPrefix: string,
  whereSuffix: string
): string {
  let rawCode: string;

  if (fields !== undefined) {
    // Struct
    switch (traitName) {
      case "Eq":
        rawCode = generateStructEq(typeName, fields);
        break;
      case "Hash":
        rawCode = generateStructHash(typeName, fields);
        break;
      case "Clone":
        rawCode = generateStructClone(typeName, fields);
        break;
      case "Ord":
        rawCode = generateStructOrd(typeName, fields);
        break;
      case "ToString":
        rawCode = generateStructToString(typeName, fields);
        break;
    }
  } else {
    // Enum
    switch (traitName) {
      case "Eq":
        rawCode = generateEnumEq(typeName, variants!);
        break;
      case "Hash":
        rawCode = generateEnumHash(typeName, variants!);
        break;
      case "Clone":
        rawCode = generateEnumClone(typeName, variants!);
        break;
      case "Ord":
        rawCode = generateEnumOrd(typeName, variants!);
        break;
      case "ToString":
        rawCode = generateEnumToString(typeName, variants!);
        break;
    }
  }

  // If no forall/where, return as-is
  if (!forallPrefix && !whereSuffix) {
    return rawCode;
  }

  // Inject forall/where into the impl(...) call
  // Raw code is: `impl(TypeName, TraitExpr(...))`
  // We need: `impl(forall(...), TypeName, where(...), TraitExpr(...))`
  // Strategy: replace `impl(TypeName,` with `impl(forallPrefix TypeName, whereSuffix`
  // But this is fragile. Instead, since we control the generators, let's insert directly.
  const implPrefix = `impl(${forallPrefix}`;
  const rawWithoutImpl = rawCode.slice("impl(".length);
  // rawWithoutImpl = "TypeName, TraitExpr(...))"
  // Find the first comma after typeName to insert whereSuffix
  const firstComma = rawWithoutImpl.indexOf(",");
  if (firstComma === -1) {
    return rawCode; // shouldn't happen
  }
  const typeNamePart = rawWithoutImpl.slice(0, firstComma);
  const traitPart = rawWithoutImpl.slice(firstComma);
  // traitPart = ", TraitExpr(...))"

  return `${implPrefix}${typeNamePart}${whereSuffix}${traitPart}`;
}

// ============================================================
// Struct Eq
// ============================================================

function generateStructEq(typeName: string, fields: TypeField[]): string {
  if (fields.length === 0) {
    return `impl(${typeName}, Eq(${typeName})(
  (==) : ((lhs, rhs) -> true),
  (!=) : ((lhs, rhs) -> false)
))`;
  }

  // Build field-wise comparisons
  const eqParts = fields.map((f) => `(lhs.${f.label} == rhs.${f.label})`);
  const neqParts = fields.map((f) => `(lhs.${f.label} != rhs.${f.label})`);

  const eqBody = joinWithOperator(eqParts, "&&");
  const neqBody = joinWithOperator(neqParts, "||");

  return `impl(${typeName}, Eq(${typeName})(
  (==) : ((lhs, rhs) -> ${eqBody}),
  (!=) : ((lhs, rhs) -> ${neqBody})
))`;
}

// ============================================================
// Struct Hash
// ============================================================

function generateStructHash(typeName: string, fields: TypeField[]): string {
  if (fields.length === 0) {
    return `impl(${typeName}, Hash(
  (hash): ((self) -> u64(0))
))`;
  }

  // Hash all fields and combine
  const stmts: string[] = [];
  stmts.push(`(h : u64) = (&(self.*.${fields[0]!.label})).hash()`);
  for (let i = 1; i < fields.length; i++) {
    stmts.push(`h = ((h * u64(31)) + (&(self.*.${fields[i]!.label})).hash())`);
  }
  stmts.push("return h");

  return `impl(${typeName}, Hash(
  (hash): ((self) -> {
    ${stmts.join(";\n    ")};
  })
))`;
}

// ============================================================
// Struct Clone
// ============================================================

function generateStructClone(typeName: string, fields: TypeField[]): string {
  if (fields.length === 0) {
    return `impl(${typeName}, Clone(
  clone : ((self) -> ${typeName}())
))`;
  }

  // Clone each field
  const clonedFields = fields.map((f) => `(&(self.*.${f.label})).clone()`);

  return `impl(${typeName}, Clone(
  clone : ((self) -> ${typeName}(${clonedFields.join(", ")}))
))`;
}

// ============================================================
// Struct Ord
// ============================================================

function generateStructOrd(typeName: string, fields: TypeField[]): string {
  if (fields.length === 0) {
    // All empty structs are equal, so all comparisons return false except <= and >=
    return `impl(${typeName}, Ord(${typeName})(
  (<) : ((lhs, rhs) -> false),
  (<=) : ((lhs, rhs) -> true),
  (>) : ((lhs, rhs) -> false),
  (>=) : ((lhs, rhs) -> true)
))`;
  }

  // Lexicographic comparison for each operator
  const ltBody = generateLexicographicOrd(fields, "<");
  const leBody = generateLexicographicOrd(fields, "<=");
  const gtBody = generateLexicographicOrd(fields, ">");
  const geBody = generateLexicographicOrd(fields, ">=");

  return `impl(${typeName}, Ord(${typeName})(
  (<) : ((lhs, rhs) -> ${ltBody}),
  (<=) : ((lhs, rhs) -> ${leBody}),
  (>) : ((lhs, rhs) -> ${gtBody}),
  (>=) : ((lhs, rhs) -> ${geBody})
))`;
}

function generateLexicographicOrd(fields: TypeField[], op: string): string {
  // For a single field, just compare directly
  if (fields.length === 1) {
    return `(lhs.${fields[0]!.label} ${op} rhs.${fields[0]!.label})`;
  }

  // For multiple fields, use cond for lexicographic ordering.
  // For < : if first field differs, return (lhs.f1 < rhs.f1), else check next field
  // For <= : same logic, last field uses <=
  const branches: string[] = [];

  for (let i = 0; i < fields.length - 1; i++) {
    const f = fields[i]!.label;
    branches.push(`(lhs.${f} != rhs.${f}) => (lhs.${f} ${op} rhs.${f})`);
  }

  const lastField = fields[fields.length - 1]!.label;
  branches.push(`true => (lhs.${lastField} ${op} rhs.${lastField})`);

  return `cond(\n      ${branches.join(",\n      ")}\n    )`;
}

// ============================================================
// Struct ToString
// ============================================================

function generateStructToString(typeName: string, fields: TypeField[]): string {
  if (fields.length === 0) {
    return `impl(${typeName}, ToString(
  to_string : ((self) -> String.from("${typeName}()"))
))`;
  }

  // Build string concatenation using + operator
  // "TypeName(field1, field2, ...)"
  const parts: string[] = [];
  parts.push(`String.from("${typeName}(")`);
  for (let i = 0; i < fields.length; i++) {
    if (i > 0) {
      parts.push(`String.from(", ")`);
    }
    parts.push(`(&(self.*.${fields[i]!.label})).to_string()`);
  }
  parts.push(`String.from(")")`);

  const body = joinWithOperator(parts, "+");

  return `impl(${typeName}, ToString(
  to_string : ((self) -> ${body})
))`;
}

// ============================================================
// Enum derives
// ============================================================

function deriveTraitForEnum({
  traitName,
  enumType,
  typeName,
  env,
  context,
  token,
  forallPrefix,
  whereSuffix,
  hasForall,
}: {
  traitName: DerivableTraitName;
  enumType: EnumType;
  typeName: string;
  env: Environment;
  context: EvaluatorContext;
  token: Expr["token"];
  forallPrefix: string;
  whereSuffix: string;
  hasForall: boolean;
}): Environment {
  const variants = enumType.variants;

  // Skip field-level validation when forall is present
  if (!hasForall) {
    switch (traitName) {
      case "Eq":
        validateEnumFieldsImplementTrait(
          variants,
          "Eq",
          typeName,
          env,
          context,
          token
        );
        break;
      case "Hash":
        validateEnumFieldsImplementTrait(
          variants,
          "Hash",
          typeName,
          env,
          context,
          token
        );
        break;
      case "Clone":
        validateEnumFieldsImplementTrait(
          variants,
          "Clone",
          typeName,
          env,
          context,
          token
        );
        break;
      case "Ord":
        validateEnumFieldsImplementTrait(
          variants,
          "Eq",
          typeName,
          env,
          context,
          token
        );
        validateEnumFieldsImplementTrait(
          variants,
          "Ord",
          typeName,
          env,
          context,
          token
        );
        break;
      case "ToString":
        validateEnumFieldsImplementTrait(
          variants,
          "ToString",
          typeName,
          env,
          context,
          token
        );
        break;
    }
  }

  const code = generateImplCodeForTrait(
    traitName,
    typeName,
    undefined,
    variants,
    forallPrefix,
    whereSuffix
  );
  return evalImplCode(code, enumType, env, context, token);
}

function validateEnumFieldsImplementTrait(
  variants: EnumVariant[],
  traitName: string,
  typeName: string,
  env: Environment,
  context: EvaluatorContext,
  token: Expr["token"]
): void {
  for (const variant of variants) {
    if (!variant.fields) continue;
    for (const field of variant.fields) {
      const traitType = resolveTraitTypeFromEnv(
        traitName,
        field.type,
        env,
        context
      );
      if (
        traitType &&
        !typeImplementsTrait({ targetType: field.type, traitType, env })
      ) {
        throw formatErrorMessage({
          token,
          errorMessage: `Cannot derive ${traitName} for ${typeName}: field '${field.label}' of variant '${variant.name}' (type ${typeToString(field.type)}) does not implement ${traitName}`,
        });
      }
    }
  }
}

// ============================================================
// Enum Eq
// ============================================================

function generateEnumEq(typeName: string, variants: EnumVariant[]): string {
  // For enums, we need to match on both lhs and rhs
  // Simple approach: compare as i32 discriminant for fieldless enums
  // For enums with fields, use match

  const allFieldless = variants.every(
    (v) => !v.fields || v.fields.length === 0
  );

  if (allFieldless) {
    // Simple: cast to i32 and compare
    return `impl(${typeName}, Eq(${typeName})(
  (==) : ((lhs, rhs) -> (i32(lhs) == i32(rhs))),
  (!=) : ((lhs, rhs) -> (i32(lhs) != i32(rhs)))
))`;
  }

  // For enums with fields: generate nested match
  const eqBranches: string[] = [];
  const neqBranches: string[] = [];

  for (const variant of variants) {
    if (!variant.fields || variant.fields.length === 0) {
      // Fieldless variant
      eqBranches.push(
        `.${variant.name} => match(rhs, .${variant.name} => true, _ => false)`
      );
      neqBranches.push(
        `.${variant.name} => match(rhs, .${variant.name} => false, _ => true)`
      );
    } else {
      // Variant with fields
      const lhsBindings = variant.fields
        .map((f) => `__lhs_${f.label}`)
        .join(", ");
      const rhsBindings = variant.fields
        .map((f) => `__rhs_${f.label}`)
        .join(", ");
      const eqComparisons = variant.fields.map(
        (f) => `(__lhs_${f.label} == __rhs_${f.label})`
      );
      const neqComparisons = variant.fields.map(
        (f) => `(__lhs_${f.label} != __rhs_${f.label})`
      );

      const eqBody = joinWithOperator(eqComparisons, "&&");
      const neqBody = joinWithOperator(neqComparisons, "||");

      eqBranches.push(
        `.${variant.name}(${lhsBindings}) => match(rhs, .${variant.name}(${rhsBindings}) => ${eqBody}, _ => false)`
      );
      neqBranches.push(
        `.${variant.name}(${lhsBindings}) => match(rhs, .${variant.name}(${rhsBindings}) => ${neqBody}, _ => true)`
      );
    }
  }

  return `impl(${typeName}, Eq(${typeName})(
  (==) : ((lhs, rhs) -> match(lhs,
    ${eqBranches.join(",\n    ")}
  )),
  (!=) : ((lhs, rhs) -> match(lhs,
    ${neqBranches.join(",\n    ")}
  ))
))`;
}

// ============================================================
// Enum Hash
// ============================================================

function generateEnumHash(typeName: string, variants: EnumVariant[]): string {
  const branches: string[] = [];

  for (let vi = 0; vi < variants.length; vi++) {
    const variant = variants[vi]!;
    if (!variant.fields || variant.fields.length === 0) {
      branches.push(`.${variant.name} => u64(${vi})`);
    } else {
      const bindings = variant.fields.map((f) => `__v_${f.label}`).join(", ");
      const stmts: string[] = [`(h : u64) = u64(${vi})`];
      for (const field of variant.fields) {
        stmts.push(`h = ((h * u64(31)) + (&(__v_${field.label})).hash())`);
      }
      stmts.push("h");
      branches.push(
        `.${variant.name}(${bindings}) => { ${stmts.join("; ")}; }`
      );
    }
  }

  return `impl(${typeName}, Hash(
  (hash): ((self) -> match(self.*,
    ${branches.join(",\n    ")}
  ))
))`;
}

// ============================================================
// Enum Clone
// ============================================================

function generateEnumClone(typeName: string, variants: EnumVariant[]): string {
  const branches: string[] = [];

  for (const variant of variants) {
    if (!variant.fields || variant.fields.length === 0) {
      branches.push(`.${variant.name} => .${variant.name}`);
    } else {
      const bindings = variant.fields.map((f) => `__v_${f.label}`).join(", ");
      const clonedFields = variant.fields
        .map((f) => `(&(__v_${f.label})).clone()`)
        .join(", ");
      branches.push(
        `.${variant.name}(${bindings}) => .${variant.name}(${clonedFields})`
      );
    }
  }

  return `impl(${typeName}, Clone(
  clone : ((self) -> match(self.*,
    ${branches.join(",\n    ")}
  ))
))`;
}

// ============================================================
// Enum Ord
// ============================================================

function generateEnumOrd(typeName: string, variants: EnumVariant[]): string {
  // Compare by discriminant first, then fields lexicographically
  const allFieldless = variants.every(
    (v) => !v.fields || v.fields.length === 0
  );

  if (allFieldless) {
    return `impl(${typeName}, Ord(${typeName})(
  (<) : ((lhs, rhs) -> (i32(lhs) < i32(rhs))),
  (<=) : ((lhs, rhs) -> (i32(lhs) <= i32(rhs))),
  (>) : ((lhs, rhs) -> (i32(lhs) > i32(rhs))),
  (>=) : ((lhs, rhs) -> (i32(lhs) >= i32(rhs)))
))`;
  }

  // For enums with fields: compare discriminant first, then fields
  const genOp = (op: string): string => {
    const branches: string[] = [];
    for (const variant of variants) {
      if (!variant.fields || variant.fields.length === 0) {
        branches.push(
          `.${variant.name} => match(rhs, .${variant.name} => ${op === "<=" || op === ">=" ? "true" : "false"}, _ => (i32(lhs) ${op} i32(rhs)))`
        );
      } else {
        const lhsBindings = variant.fields
          .map((f) => `__lhs_${f.label}`)
          .join(", ");
        const rhsBindings = variant.fields
          .map((f) => `__rhs_${f.label}`)
          .join(", ");
        const fieldOrd = generateLexicographicOrdForBindings(
          variant.fields,
          op
        );
        branches.push(
          `.${variant.name}(${lhsBindings}) => match(rhs, .${variant.name}(${rhsBindings}) => ${fieldOrd}, _ => (i32(lhs) ${op} i32(rhs)))`
        );
      }
    }
    return `match(lhs,\n      ${branches.join(",\n      ")}\n    )`;
  };

  return `impl(${typeName}, Ord(${typeName})(
  (<) : ((lhs, rhs) -> ${genOp("<")}),
  (<=) : ((lhs, rhs) -> ${genOp("<=")}),
  (>) : ((lhs, rhs) -> ${genOp(">")}),
  (>=) : ((lhs, rhs) -> ${genOp(">=")}))
))`;
}

function generateLexicographicOrdForBindings(
  fields: TypeField[],
  op: string
): string {
  if (fields.length === 1) {
    return `(__lhs_${fields[0]!.label} ${op} __rhs_${fields[0]!.label})`;
  }

  const branches: string[] = [];
  for (let i = 0; i < fields.length - 1; i++) {
    const f = fields[i]!.label;
    branches.push(
      `(__lhs_${f} != __rhs_${f}) => (__lhs_${f} ${op} __rhs_${f})`
    );
  }
  const lastField = fields[fields.length - 1]!.label;
  branches.push(`true => (__lhs_${lastField} ${op} __rhs_${lastField})`);

  return `cond(\n        ${branches.join(",\n        ")}\n      )`;
}

// ============================================================
// Enum ToString
// ============================================================

function generateEnumToString(
  typeName: string,
  variants: EnumVariant[]
): string {
  const branches: string[] = [];

  for (const variant of variants) {
    if (!variant.fields || variant.fields.length === 0) {
      branches.push(
        `.${variant.name} => String.from("${typeName}.${variant.name}")`
      );
    } else {
      const bindings = variant.fields.map((f) => `__v_${f.label}`).join(", ");
      // Build string concatenation
      const parts: string[] = [];
      parts.push(`String.from("${typeName}.${variant.name}(")`);
      for (let i = 0; i < variant.fields.length; i++) {
        if (i > 0) {
          parts.push(`String.from(", ")`);
        }
        parts.push(`(&(__v_${variant.fields[i]!.label})).to_string()`);
      }
      parts.push(`String.from(")")`);
      const body = joinWithOperator(parts, "+");
      branches.push(`.${variant.name}(${bindings}) => ${body}`);
    }
  }

  return `impl(${typeName}, ToString(
  to_string : ((self) -> match(self.*,
    ${branches.join(",\n    ")}
  ))
))`;
}

// ============================================================
// Helpers
// ============================================================

/**
 * Join expressions with a binary operator, properly parenthesized.
 * Yo has no operator precedence, so we must nest left-to-right.
 */
function joinWithOperator(parts: string[], op: string): string {
  if (parts.length === 0) return "true";
  if (parts.length === 1) return parts[0]!;

  let result = parts[0]!;
  for (let i = 1; i < parts.length; i++) {
    result = `(${result} ${op} ${parts[i]!})`;
  }
  return result;
}
