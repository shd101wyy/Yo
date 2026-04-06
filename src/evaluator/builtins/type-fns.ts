import type { Environment } from "../../env";
import { addVariableToEnv, pushEnvFrame, popEnvFrame } from "../../env";
import { generateVarialeId } from "../../utils";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  ExprTag,
  expectExprToBeFunctionCallOf,
  exprToString,
  type Expr,
  type FnCallExpr,
} from "../../expr";
import { generateExprFromCode, generateExprsFromCode } from "../../parser";
import { areTypesCompatible } from "../../types/compatibility";
import {
  createBooleanType,
  createComptimeIntType,
  createComptimeStringType,
  createExprType,
} from "../../types/creators";
import type {
  EnumType,
  StructType,
  TraitType,
  Type,
} from "../../types/definitions";
import { TypeTag } from "../../types/tags";
import {
  isEnumType,
  isStructType,
  isSomeType,
  isTraitType,
  isTypeHierarchyType,
} from "../../types/guards";
import {
  canTypeFormRcCycle,
  typeContainsRcType,
  typeToString,
} from "../../types/utils";
import { VUnit } from "../../unit-value";
import {
  createBooleanValue,
  createComptimeIntValue,
  createComptimeStringValue,
  createExprValue,
  createTypeValue,
  createUnknownValue,
  createComptimeListValue as createComptimeListValueFn,
  isComptimeIntValue,
  isComptimeStringValue,
  isExprValue,
  isFunctionValue,
  isTypeValue,
  type Value,
} from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { typeImplementsTrait } from "../trait-checking";
import { PlaceholderToken } from "../../token";

export function evaluateYoTypeToString({
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
    BuiltinFunctions.__yo_type_to_comptime_string,
    1
  );

  const arg = evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: {
      ...context,
    },
  });
  if (!arg.$) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
        arg
      )}`,
    });
  }
  if (!isTypeHierarchyType(arg.$.type)) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Expected TypeHierarchy type for "${expr.func.token.value}" argument, got:\n${exprToString(
        arg
      )}`,
    });
  }
  const typeValue = arg.$.value;
  if (!typeValue) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Expected type value for "${expr.func.token.value}" argument, got:\n${exprToString(
        arg
      )}`,
    });
  }

  expr.$ = {
    env: arg.$.env,
    type: createComptimeStringType(),
    value: createUnknownValue(createComptimeStringType(), {
      env: arg.$.env,
      context,
    }), // Will be updated later
    pathCollection: [],
    isAccessingProperty: false,
  };

  if (isTypeValue(typeValue)) {
    expr.$.value = createComptimeStringValue(typeToString(typeValue.value));
  }
  return expr;
}

/**
 * Check if two types are compatible
 */
export function evaluateYoAreTypesCompatible({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const args = expr.args;
  const expectedTypeArg = args[0]!;
  const givenTypeArg = args[1]!;

  const evaluatedExpectedTypeArg = evaluateExpression({
    expr: expectedTypeArg,
    env,
    context: {
      ...context,
      expectedType: undefined,
      SelfType: undefined,
    },
  });
  if (!isTypeValue(evaluatedExpectedTypeArg.$?.value)) {
    throw formatErrorMessage({
      token: expectedTypeArg.token,
      errorMessage: `Expected type, got:\n${exprToString(expectedTypeArg)}`,
    });
  }
  const expectedType = evaluatedExpectedTypeArg.$.value.value;
  env = evaluatedExpectedTypeArg.$.env;

  const evaluatedGivenTypeArg = evaluateExpression({
    expr: givenTypeArg,
    env,
    context: {
      ...context,
      expectedType: undefined,
      SelfType: undefined,
    },
  });
  if (!isTypeValue(evaluatedGivenTypeArg.$?.value)) {
    throw formatErrorMessage({
      token: givenTypeArg.token,
      errorMessage: `Expected type, got:\n${exprToString(givenTypeArg)}`,
    });
  }
  const givenType = evaluatedGivenTypeArg.$.value.value;
  env = evaluatedGivenTypeArg.$.env;

  // Check if the types are compatible
  const compatible = areTypesCompatible(
    { type: expectedType, env },
    { type: givenType, env }
  );

  // Attach info to the expr
  const booleanValue = createBooleanValue(compatible);
  expr.$ = {
    env,
    type: booleanValue.type,
    value: booleanValue,
    pathCollection: [],
  };
  return expr;
}

export function evaluateYoTypeContainsRcType({
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
    BuiltinFunctions.__yo_type_contains_rc_type,
    1
  );

  const arg = evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: {
      ...context,
    },
  });
  if (!arg.$) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
        arg
      )}`,
    });
  }
  if (!isTypeHierarchyType(arg.$.type)) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Expected TypeHierarchy type for "${expr.func.token.value}" argument, got:\n${exprToString(
        arg
      )}`,
    });
  }
  const typeValue = arg.$.value;
  if (!typeValue || !isTypeValue(typeValue)) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Expected type value for "${expr.func.token.value}" argument, got:\n${exprToString(
        arg
      )}`,
    });
  }

  const flag = typeContainsRcType(typeValue.value);
  const value = createBooleanValue(flag);

  expr.$ = {
    env: arg.$.env,
    type: value.type,
    value: value,
    pathCollection: [],
    isAccessingProperty: false,
  };

  return expr;
}

export function evaluateYoTypeCanFormRcCycle({
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
    BuiltinFunctions.__yo_type_can_form_rc_cycle,
    1
  );

  const arg = evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: {
      ...context,
    },
  });
  if (!arg.$) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Failed to evaluate the argument expression for "${expr.func.token.value}":\n${exprToString(
        arg
      )}`,
    });
  }
  if (!isTypeHierarchyType(arg.$.type)) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Expected TypeHierarchy type for "${expr.func.token.value}" argument, got:\n${exprToString(
        arg
      )}`,
    });
  }
  const typeValue = arg.$.value;
  if (!typeValue || !isTypeValue(typeValue)) {
    throw formatErrorMessage({
      token: arg.token,
      errorMessage: `Expected type value for "${expr.func.token.value}" argument, got:\n${exprToString(
        arg
      )}`,
    });
  }

  const flag = canTypeFormRcCycle(typeValue.value, new Set(), arg.$.env);
  const value = createBooleanValue(flag);

  expr.$ = {
    env: arg.$.env,
    type: value.type,
    value: value,
    pathCollection: [],
    isAccessingProperty: false,
  };

  return expr;
}

/**
 * Check if a type implements a trait.
 * Usage: __yo_type_impls(SomeType, SomeTrait)
 * Returns: comptime(bool)
 *
 * This checks if the type's trait has a field whose assignedValue is a ModuleValue
 * that structurally matches the given trait (with the type as the receiver).
 */
export function evaluateYoTypeImpls({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_type_impls, 2);

  // Evaluate the first argument (the type to check)
  const typeArg = evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: {
      ...context,
    },
  });
  if (!typeArg.$) {
    throw formatErrorMessage({
      token: typeArg.token,
      errorMessage: `Failed to evaluate the type argument for "${expr.func.token.value}":\n${exprToString(
        typeArg
      )}`,
    });
  }
  if (!isTypeHierarchyType(typeArg.$.type)) {
    throw formatErrorMessage({
      token: typeArg.token,
      errorMessage: `Expected Type for first argument of "${expr.func.token.value}", got:\n${exprToString(
        typeArg
      )}`,
    });
  }
  const typeValue = typeArg.$.value;
  if (!typeValue || !isTypeValue(typeValue)) {
    throw formatErrorMessage({
      token: typeArg.token,
      errorMessage: `Expected type value for first argument of "${expr.func.token.value}", got:\n${exprToString(
        typeArg
      )}`,
    });
  }
  env = typeArg.$.env;
  const targetType = typeValue.value;

  // Evaluate the second argument (the trait to check for)
  const traitArg = evaluateExpression({
    expr: expr.args[1]!,
    env,
    context: {
      ...context,
    },
  });
  if (!traitArg.$) {
    throw formatErrorMessage({
      token: traitArg.token,
      errorMessage: `Failed to evaluate the trait argument for "${expr.func.token.value}":\n${exprToString(
        traitArg
      )}`,
    });
  }

  // The trait argument should be a type value containing a trait type
  // Or it could be the trait type directly (when passed as a comptime parameter)
  // If the argument is a compile-time unknown (Type hierarchy), return unknown bool
  let expectedTraitType: TraitType;

  if (isTypeValue(traitArg.$.value)) {
    const traitTypeValue = traitArg.$.value;
    if (!isTraitType(traitTypeValue.value)) {
      throw formatErrorMessage({
        token: traitArg.token,
        errorMessage: `Expected trait type for second argument of "${expr.func.token.value}", got a non-trait type`,
      });
    }
    expectedTraitType = traitTypeValue.value;
  } else if (isTraitType(traitArg.$.type)) {
    // The argument is a trait type itself (the type of the value is TraitType)
    expectedTraitType = traitArg.$.type;
  } else if (isTypeHierarchyType(traitArg.$.type)) {
    // The argument is a compile-time unknown (e.g., a generic parameter like `marker: Trait`)
    // Return an unknown bool value - the actual check will happen when called with concrete types
    expr.$ = {
      env: traitArg.$.env,
      type: createBooleanType(),
      value: createUnknownValue(createBooleanType(), {
        env: traitArg.$.env,
        context,
      }),
      pathCollection: [],
      isAccessingProperty: false,
    };
    return expr;
  } else {
    throw formatErrorMessage({
      token: traitArg.token,
      errorMessage: `Expected trait type for second argument of "${expr.func.token.value}", got:\n${exprToString(
        traitArg
      )}`,
    });
  }
  env = traitArg.$.env;

  const value = createBooleanValue(
    typeImplementsTrait({ targetType, traitType: expectedTraitType, env })
  );

  expr.$ = {
    env,
    type: value.type,
    value: value,
    pathCollection: [],
    isAccessingProperty: false,
  };

  return expr;
}

// ============================================================
// Type reflection builtins
// ============================================================

/** Helper: evaluate single type arg and return the Type */
function evaluateTypeArg({
  expr,
  env,
  context,
  builtinName,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
  builtinName: string;
}): { type: Type; env: Environment } {
  const arg = evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: { ...context },
  });

  if (!arg.$ || !isTypeValue(arg.$.value)) {
    throw formatErrorMessage({
      token: expr.args[0]!.token,
      errorMessage: `${builtinName}: expected a Type argument, got: ${exprToString(expr.args[0]!)}`,
    });
  }

  return { type: arg.$.value.value, env: arg.$.env };
}

/** Helper: evaluate type arg + comptime_int index */
function evaluateTypeAndIndexArgs({
  expr,
  env,
  context,
  builtinName,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
  builtinName: string;
}): { type: Type; index: number; env: Environment } {
  const typeArg = evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: { ...context },
  });

  if (!typeArg.$ || !isTypeValue(typeArg.$.value)) {
    throw formatErrorMessage({
      token: expr.args[0]!.token,
      errorMessage: `${builtinName}: first argument must be a Type`,
    });
  }

  const indexArg = evaluateExpression({
    expr: expr.args[1]!,
    env: typeArg.$.env,
    context: { ...context },
  });

  if (!indexArg.$) {
    throw formatErrorMessage({
      token: expr.args[1]!.token,
      errorMessage: `${builtinName}: second argument must be a comptime_int`,
    });
  }

  // Index may be unknown (e.g., in a comptime function body with SomeType)
  const index = isComptimeIntValue(indexArg.$.value)
    ? Number(indexArg.$.value.value)
    : -1; // -1 signals unknown index

  return {
    type: typeArg.$.value.value,
    index,
    env: indexArg.$.env,
  };
}

/** __yo_type_is_struct(T) -> comptime(bool) */
export function evaluateYoTypeIsStruct({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const { type, env: nextEnv } = evaluateTypeArg({
    expr,
    env,
    context,
    builtinName: "__yo_type_is_struct",
  });

  if (isSomeType(type)) {
    const value = createUnknownValue(createBooleanType(), {
      env: nextEnv,
      context,
    });
    expr.$ = { env: nextEnv, type: value.type, value, pathCollection: [] };
    return expr;
  }

  const value = createBooleanValue(isStructType(type));
  expr.$ = {
    env: nextEnv,
    type: value.type,
    value,
    pathCollection: [],
  };
  return expr;
}

/** __yo_type_is_enum(T) -> comptime(bool) */
export function evaluateYoTypeIsEnum({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const { type, env: nextEnv } = evaluateTypeArg({
    expr,
    env,
    context,
    builtinName: "__yo_type_is_enum",
  });

  if (isSomeType(type)) {
    const value = createUnknownValue(createBooleanType(), {
      env: nextEnv,
      context,
    });
    expr.$ = { env: nextEnv, type: value.type, value, pathCollection: [] };
    return expr;
  }

  const value = createBooleanValue(isEnumType(type));
  expr.$ = {
    env: nextEnv,
    type: value.type,
    value,
    pathCollection: [],
  };
  return expr;
}

/** __yo_type_get_tag(T) -> comptime(TypeTag)
 *
 * Maps a Type to its TypeTag enum variant (1:1 with compiler's internal TypeTag).
 */
export function evaluateYoTypeGetTag({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const { type, env: nextEnv } = evaluateTypeArg({
    expr,
    env,
    context,
    builtinName: "__yo_type_get_tag",
  });

  if (isSomeType(type)) {
    // During validation, return UnknownValue with the TypeTag enum type.
    // Look up TypeTag from the env to get the correct enum type.
    const typeTagExpr = generateExprFromCode("TypeTag.Struct");
    const typeTagResult = evaluateExpression({
      expr: typeTagExpr,
      env: nextEnv,
      context: { ...context, forceCompileTimeBindings: true },
    });
    if (typeTagResult.$) {
      const value = createUnknownValue(typeTagResult.$.type, {
        env: nextEnv,
        context,
      });
      expr.$ = { env: nextEnv, type: value.type, value, pathCollection: [] };
    }
    return expr;
  }

  // Map TypeTag to TypeTag variant name (1:1 mapping)
  const variantName = typeTagToVariantName(type.tag);
  const code = `TypeTag.${variantName}`;
  const tagExpr = generateExprFromCode(code);
  const result = evaluateExpression({
    expr: tagExpr,
    env: nextEnv,
    context: { ...context, forceCompileTimeBindings: true },
  });

  if (!result.$ || !result.$.value) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `__yo_type_get_tag: failed to create TypeTag.${variantName}`,
    });
  }

  expr.$ = {
    env: nextEnv,
    type: result.$.type,
    value: result.$.value,
    pathCollection: [],
  };
  return expr;
}

/**
 * Maps compiler TypeTag string value to Yo TypeTag enum variant name.
 * This is a 1:1 mapping — the Yo TypeTag enum mirrors the compiler's internal TypeTag.
 */
function typeTagToVariantName(tag: string): string {
  switch (tag) {
    case TypeTag.Unit:
      return "Unit";
    case TypeTag.Bool:
      return "Bool";
    case TypeTag.Usize:
      return "Usize";
    case TypeTag.Isize:
      return "Isize";
    case TypeTag.U8:
      return "U8";
    case TypeTag.I8:
      return "I8";
    case TypeTag.U16:
      return "U16";
    case TypeTag.I16:
      return "I16";
    case TypeTag.U32:
      return "U32";
    case TypeTag.I32:
      return "I32";
    case TypeTag.U64:
      return "U64";
    case TypeTag.I64:
      return "I64";
    case TypeTag.F32:
      return "F32";
    case TypeTag.F64:
      return "F64";
    case TypeTag.ComptimeInt:
      return "ComptimeInt";
    case TypeTag.ComptimeFloat:
      return "ComptimeFloat";
    case TypeTag.ComptimeString:
      return "ComptimeString";
    case TypeTag.Char:
      return "Char";
    case TypeTag.Short:
      return "Short";
    case TypeTag.UShort:
      return "UShort";
    case TypeTag.Int:
      return "Int";
    case TypeTag.UInt:
      return "UInt";
    case TypeTag.Long:
      return "Long";
    case TypeTag.ULong:
      return "ULong";
    case TypeTag.LongLong:
      return "LongLong";
    case TypeTag.ULongLong:
      return "ULongLong";
    case TypeTag.LongDouble:
      return "LongDouble";
    case TypeTag.Void:
      return "Void";
    case TypeTag.Type:
      return "Type";
    case TypeTag.Array:
      return "Array";
    case TypeTag.Tuple:
      return "Tuple";
    case TypeTag.Struct:
      return "Struct";
    case TypeTag.Enum:
      return "Enum";
    case TypeTag.Union:
      return "Union";
    case TypeTag.Function:
      return "Function";
    case TypeTag.SomeType:
      return "SomeType";
    case TypeTag.Slice:
      return "Slice";
    case TypeTag.Module:
      return "Module";
    case TypeTag.Trait:
      return "Trait";
    case TypeTag.Ptr:
      return "Ptr";
    case TypeTag.Iso:
      return "Iso";
    case TypeTag.Arc:
      return "Arc";
    case TypeTag.Dyn:
      return "Dyn";
    case TypeTag.Expr:
      return "Expr";
    case TypeTag.ComptimeList:
      return "ComptimeList";
    case TypeTag.EffectsRow:
      return "EffectsRow";
    case TypeTag.TypeApplication:
      return "TypeApplication";
    default:
      throw new Error(`Unknown TypeTag: ${tag}`);
  }
}

/** __yo_type_get_name(T) -> comptime(comptime_string) */
export function evaluateYoTypeGetName({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const { type, env: nextEnv } = evaluateTypeArg({
    expr,
    env,
    context,
    builtinName: "__yo_type_get_name",
  });

  if (isSomeType(type)) {
    const value = createUnknownValue(createComptimeStringType(), {
      env: nextEnv,
      context,
    });
    expr.$ = { env: nextEnv, type: value.type, value, pathCollection: [] };
    return expr;
  }

  const name = type.typeName ?? typeToString(type);
  const value = createComptimeStringValue(name);
  expr.$ = {
    env: nextEnv,
    type: value.type,
    value,
    pathCollection: [],
  };
  return expr;
}

/** __yo_type_field_count(T) -> comptime(comptime_int) */
export function evaluateYoTypeFieldCount({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const { type, env: nextEnv } = evaluateTypeArg({
    expr,
    env,
    context,
    builtinName: "__yo_type_field_count",
  });

  if (isSomeType(type)) {
    const value = createUnknownValue(createComptimeIntType(), {
      env: nextEnv,
      context,
    });
    expr.$ = { env: nextEnv, type: value.type, value, pathCollection: [] };
    return expr;
  }

  if (!isStructType(type)) {
    throw formatErrorMessage({
      token: expr.args[0]!.token,
      errorMessage: `__yo_type_field_count: expected a struct type, got: ${typeToString(type)}`,
    });
  }

  const value = createComptimeIntValue(BigInt(type.fields.length));
  expr.$ = {
    env: nextEnv,
    type: value.type,
    value,
    pathCollection: [],
  };
  return expr;
}

/** __yo_type_get_field_name(T, index) -> comptime(comptime_string) */
export function evaluateYoTypeGetFieldName({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const {
    type,
    index,
    env: nextEnv,
  } = evaluateTypeAndIndexArgs({
    expr,
    env,
    context,
    builtinName: "__yo_type_get_field_name",
  });

  if (isSomeType(type) || index === -1) {
    const value = createUnknownValue(createComptimeStringType(), {
      env: nextEnv,
      context,
    });
    expr.$ = { env: nextEnv, type: value.type, value, pathCollection: [] };
    return expr;
  }

  if (!isStructType(type)) {
    throw formatErrorMessage({
      token: expr.args[0]!.token,
      errorMessage: `__yo_type_get_field_name: expected a struct type, got: ${typeToString(type)}`,
    });
  }

  if (index < 0 || index >= type.fields.length) {
    throw formatErrorMessage({
      token: expr.args[1]!.token,
      errorMessage: `__yo_type_get_field_name: index ${index} out of bounds for ${typeToString(type)} with ${type.fields.length} fields`,
    });
  }

  const value = createComptimeStringValue(type.fields[index]!.label);
  expr.$ = {
    env: nextEnv,
    type: value.type,
    value,
    pathCollection: [],
  };
  return expr;
}

/** __yo_type_get_field_type(T, index) -> comptime(Type) */
export function evaluateYoTypeGetFieldType({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const {
    type,
    index,
    env: nextEnv,
  } = evaluateTypeAndIndexArgs({
    expr,
    env,
    context,
    builtinName: "__yo_type_get_field_type",
  });

  if (isSomeType(type) || index === -1) {
    const value = createUnknownValue(createTypeValue(type).type, {
      env: nextEnv,
      context,
    });
    expr.$ = { env: nextEnv, type: value.type, value, pathCollection: [] };
    return expr;
  }

  if (!isStructType(type)) {
    throw formatErrorMessage({
      token: expr.args[0]!.token,
      errorMessage: `__yo_type_get_field_type: expected a struct type, got: ${typeToString(type)}`,
    });
  }

  if (index < 0 || index >= type.fields.length) {
    throw formatErrorMessage({
      token: expr.args[1]!.token,
      errorMessage: `__yo_type_get_field_type: index ${index} out of bounds for ${typeToString(type)} with ${type.fields.length} fields`,
    });
  }

  const fieldType = type.fields[index]!.type;
  const value = createTypeValue(fieldType);
  expr.$ = {
    env: nextEnv,
    type: value.type,
    value,
    pathCollection: [],
  };
  return expr;
}

/** __yo_type_variant_count(T) -> comptime(comptime_int) */
export function evaluateYoTypeVariantCount({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const { type, env: nextEnv } = evaluateTypeArg({
    expr,
    env,
    context,
    builtinName: "__yo_type_variant_count",
  });

  if (isSomeType(type)) {
    const value = createUnknownValue(createComptimeIntType(), {
      env: nextEnv,
      context,
    });
    expr.$ = { env: nextEnv, type: value.type, value, pathCollection: [] };
    return expr;
  }

  if (!isEnumType(type)) {
    throw formatErrorMessage({
      token: expr.args[0]!.token,
      errorMessage: `__yo_type_variant_count: expected an enum type, got: ${typeToString(type)}`,
    });
  }

  const value = createComptimeIntValue(BigInt(type.variants.length));
  expr.$ = {
    env: nextEnv,
    type: value.type,
    value,
    pathCollection: [],
  };
  return expr;
}

/** __yo_type_get_variant_name(T, index) -> comptime(comptime_string) */
export function evaluateYoTypeGetVariantName({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const {
    type,
    index,
    env: nextEnv,
  } = evaluateTypeAndIndexArgs({
    expr,
    env,
    context,
    builtinName: "__yo_type_get_variant_name",
  });

  if (isSomeType(type) || index === -1) {
    const value = createUnknownValue(createComptimeStringType(), {
      env: nextEnv,
      context,
    });
    expr.$ = { env: nextEnv, type: value.type, value, pathCollection: [] };
    return expr;
  }

  if (!isEnumType(type)) {
    throw formatErrorMessage({
      token: expr.args[0]!.token,
      errorMessage: `__yo_type_get_variant_name: expected an enum type, got: ${typeToString(type)}`,
    });
  }

  if (index < 0 || index >= type.variants.length) {
    throw formatErrorMessage({
      token: expr.args[1]!.token,
      errorMessage: `__yo_type_get_variant_name: index ${index} out of bounds for ${typeToString(type)} with ${type.variants.length} variants`,
    });
  }

  const value = createComptimeStringValue(type.variants[index]!.name);
  expr.$ = {
    env: nextEnv,
    type: value.type,
    value,
    pathCollection: [],
  };
  return expr;
}

/** __yo_type_get_variant_field_count(T, index) -> comptime(comptime_int) */
export function evaluateYoTypeGetVariantFieldCount({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const {
    type,
    index,
    env: nextEnv,
  } = evaluateTypeAndIndexArgs({
    expr,
    env,
    context,
    builtinName: "__yo_type_get_variant_field_count",
  });

  if (isSomeType(type) || index === -1) {
    const value = createUnknownValue(createComptimeIntType(), {
      env: nextEnv,
      context,
    });
    expr.$ = { env: nextEnv, type: value.type, value, pathCollection: [] };
    return expr;
  }

  if (!isEnumType(type)) {
    throw formatErrorMessage({
      token: expr.args[0]!.token,
      errorMessage: `__yo_type_get_variant_field_count: expected an enum type, got: ${typeToString(type)}`,
    });
  }

  if (index < 0 || index >= type.variants.length) {
    throw formatErrorMessage({
      token: expr.args[1]!.token,
      errorMessage: `__yo_type_get_variant_field_count: index ${index} out of bounds`,
    });
  }

  const variant = type.variants[index]!;
  const fieldCount = variant.fields?.length ?? 0;
  const value = createComptimeIntValue(BigInt(fieldCount));
  expr.$ = {
    env: nextEnv,
    type: value.type,
    value,
    pathCollection: [],
  };
  return expr;
}

/** __yo_type_get_variant_field_name(T, variantIndex, fieldIndex) -> comptime(comptime_string) */
export function evaluateYoTypeGetVariantFieldName({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const typeArg = evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: { ...context },
  });

  if (!typeArg.$ || !isTypeValue(typeArg.$.value)) {
    throw formatErrorMessage({
      token: expr.args[0]!.token,
      errorMessage: `__yo_type_get_variant_field_name: first argument must be a Type`,
    });
  }

  const variantIndexArg = evaluateExpression({
    expr: expr.args[1]!,
    env: typeArg.$.env,
    context: { ...context },
  });

  if (!variantIndexArg.$) {
    throw formatErrorMessage({
      token: expr.args[1]!.token,
      errorMessage: `__yo_type_get_variant_field_name: second argument must be a comptime_int`,
    });
  }

  const fieldIndexArg = evaluateExpression({
    expr: expr.args[2]!,
    env: variantIndexArg.$.env,
    context: { ...context },
  });

  if (!fieldIndexArg.$) {
    throw formatErrorMessage({
      token: expr.args[2]!.token,
      errorMessage: `__yo_type_get_variant_field_name: third argument must be a comptime_int`,
    });
  }

  const type = typeArg.$.value.value;

  // Handle SomeType or unknown indices
  if (
    isSomeType(type) ||
    !isComptimeIntValue(variantIndexArg.$.value) ||
    !isComptimeIntValue(fieldIndexArg.$.value)
  ) {
    const value = createUnknownValue(createComptimeStringType(), {
      env: fieldIndexArg.$.env,
      context,
    });
    expr.$ = {
      env: fieldIndexArg.$.env,
      type: value.type,
      value,
      pathCollection: [],
    };
    return expr;
  }

  const variantIndex = Number(variantIndexArg.$.value.value);
  const fieldIndex = Number(fieldIndexArg.$.value.value);

  if (!isEnumType(type)) {
    throw formatErrorMessage({
      token: expr.args[0]!.token,
      errorMessage: `__yo_type_get_variant_field_name: expected an enum type`,
    });
  }

  const variant = type.variants[variantIndex];
  if (!variant) {
    throw formatErrorMessage({
      token: expr.args[1]!.token,
      errorMessage: `__yo_type_get_variant_field_name: variant index ${variantIndex} out of bounds`,
    });
  }

  const field = variant.fields?.[fieldIndex];
  if (!field) {
    throw formatErrorMessage({
      token: expr.args[2]!.token,
      errorMessage: `__yo_type_get_variant_field_name: field index ${fieldIndex} out of bounds for variant ${variant.name}`,
    });
  }

  const value = createComptimeStringValue(field.label);
  expr.$ = {
    env: fieldIndexArg.$.env,
    type: value.type,
    value,
    pathCollection: [],
  };
  return expr;
}

/** __yo_type_get_variant_field_type(T, variantIndex, fieldIndex) -> comptime(Type) */
export function evaluateYoTypeGetVariantFieldType({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const typeArg = evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: { ...context },
  });

  if (!typeArg.$ || !isTypeValue(typeArg.$.value)) {
    throw formatErrorMessage({
      token: expr.args[0]!.token,
      errorMessage: `__yo_type_get_variant_field_type: first argument must be a Type`,
    });
  }

  const variantIndexArg = evaluateExpression({
    expr: expr.args[1]!,
    env: typeArg.$.env,
    context: { ...context },
  });

  if (!variantIndexArg.$) {
    throw formatErrorMessage({
      token: expr.args[1]!.token,
      errorMessage: `__yo_type_get_variant_field_type: second argument must be a comptime_int`,
    });
  }

  const fieldIndexArg = evaluateExpression({
    expr: expr.args[2]!,
    env: variantIndexArg.$.env,
    context: { ...context },
  });

  if (!fieldIndexArg.$) {
    throw formatErrorMessage({
      token: expr.args[2]!.token,
      errorMessage: `__yo_type_get_variant_field_type: third argument must be a comptime_int`,
    });
  }

  const type = typeArg.$.value.value;

  // Handle SomeType or unknown indices
  if (
    isSomeType(type) ||
    !isComptimeIntValue(variantIndexArg.$.value) ||
    !isComptimeIntValue(fieldIndexArg.$.value)
  ) {
    const value = createUnknownValue(createTypeValue(type).type, {
      env: fieldIndexArg.$.env,
      context,
    });
    expr.$ = {
      env: fieldIndexArg.$.env,
      type: value.type,
      value,
      pathCollection: [],
    };
    return expr;
  }

  const variantIndex = Number(variantIndexArg.$.value.value);
  const fieldIndex = Number(fieldIndexArg.$.value.value);

  if (!isEnumType(type)) {
    throw formatErrorMessage({
      token: expr.args[0]!.token,
      errorMessage: `__yo_type_get_variant_field_type: expected an enum type`,
    });
  }

  const variant = type.variants[variantIndex];
  if (!variant) {
    throw formatErrorMessage({
      token: expr.args[1]!.token,
      errorMessage: `__yo_type_get_variant_field_type: variant index ${variantIndex} out of bounds`,
    });
  }

  const field = variant.fields?.[fieldIndex];
  if (!field) {
    throw formatErrorMessage({
      token: expr.args[2]!.token,
      errorMessage: `__yo_type_get_variant_field_type: field index ${fieldIndex} out of bounds for variant ${variant.name}`,
    });
  }

  const value = createTypeValue(field.type);
  expr.$ = {
    env: fieldIndexArg.$.env,
    type: value.type,
    value,
    pathCollection: [],
  };
  return expr;
}

// ============================================================
// comptime_eval
// ============================================================

/**
 * comptime_eval(code_string) — parse and evaluate a comptime_string as Yo code.
 * Returns unit. Side effects: registers impls, defines variables, etc.
 */
export function evaluateComptimeEval({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const arg = evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: { ...context },
  });

  if (!arg.$) {
    throw formatErrorMessage({
      token: expr.args[0]!.token,
      errorMessage: `comptime_eval: failed to evaluate argument`,
    });
  }

  // The argument must be a comptime_string. If it's unknown (SomeType), skip evaluation.
  if (!isComptimeStringValue(arg.$.value)) {
    // If the value is unknown (e.g., in a comptime function body with SomeType params),
    // return unit without executing
    expr.$ = {
      env: arg.$.env,
      type: VUnit.type,
      value: VUnit,
      pathCollection: [],
    };
    return expr;
  }

  const codeString = arg.$.value.value;
  env = arg.$.env;

  // Parse and evaluate the code string (may produce multiple expressions, e.g. template strings)
  const codeExprs = generateExprsFromCode(codeString);

  for (const codeExpr of codeExprs) {
    const evaluatedExpr = evaluateExpression({
      expr: codeExpr,
      env,
      context: {
        ...context,
        forceCompileTimeBindings: false,
      },
    });

    if (!evaluatedExpr.$) {
      throw formatErrorMessage({
        token: expr.args[0]!.token,
        errorMessage: `comptime_eval: failed to evaluate code:\n${codeString}`,
      });
    }

    env = evaluatedExpr.$.env;
  }

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}

// ============================================================================
// Phase 2 derive_rule builtins
// ============================================================================

/** __yo_comptime_string_to_expr(code : comptime_string) -> comptime(Expr) */
export function evaluateComptimeStringToExpr({
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
    BuiltinFunctions.__yo_comptime_string_to_expr,
    1
  );

  const arg = evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: { ...context },
  });

  if (!arg.$ || !isComptimeStringValue(arg.$.value)) {
    if (arg.$?.value && isComptimeStringValue(arg.$.value) === false) {
      // Unknown value (e.g., SomeType) → return UnknownValue(Expr)
      const value = createUnknownValue(createExprType(), {
        env: arg.$.env,
        context,
      });
      expr.$ = { env: arg.$.env, type: value.type, value, pathCollection: [] };
      return expr;
    }
    throw formatErrorMessage({
      token: expr.args[0]!.token,
      errorMessage: `__yo_comptime_string_to_expr: expected a comptime_string argument`,
    });
  }

  const codeString = arg.$.value.value;
  const parsedExpr = generateExprFromCode(codeString);
  const exprValue = createExprValue(parsedExpr);

  expr.$ = {
    env: arg.$.env,
    type: exprValue.type,
    value: exprValue,
    pathCollection: [],
  };
  return expr;
}

/**
 * Helper: add a comptime-only temp variable to the env.
 * Returns the updated env.
 */
function addComptimeTempVar({
  env,
  name,
  type,
  value,
}: {
  env: Environment;
  name: string;
  type: Type;
  value: Value;
}): Environment {
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

/**
 * Helper: create a FieldInfo struct value for a given struct field.
 * Looks up the FieldInfo type from the env, or creates one on the fly.
 */
function createFieldInfoValue(
  env: Environment,
  fieldName: string,
  fieldType: Type,
  context: EvaluatorContext
): { value: Value; env: Environment } {
  // Create the FieldInfo struct value by evaluating FieldInfo("name", Type)
  // We bind the field_type to a temp var since typeToString might not roundtrip
  const tempTypeName = `__derive_ft_${generateVarialeId(env.modulePath, "dft")}`;
  env = addComptimeTempVar({
    env,
    name: tempTypeName,
    type: createTypeValue(fieldType).type,
    value: createTypeValue(fieldType),
  });

  // Escape the field name for code generation
  const escapedName = JSON.stringify(fieldName);
  const code = `FieldInfo(${escapedName}, ${tempTypeName})`;
  const callExpr = generateExprFromCode(code);
  const result = evaluateExpression({
    expr: callExpr,
    env,
    context: { ...context, forceCompileTimeBindings: true },
  });

  if (!result.$ || !result.$.value) {
    throw new Error(`Failed to create FieldInfo for field "${fieldName}"`);
  }

  return { value: result.$.value, env: result.$.env };
}

/**
 * Helper: call a mapper function with an argument value.
 * The mapper is bound to a temp var, the argument is bound to a temp var,
 * then we evaluate `mapper(arg)` and return the result.
 */
function callMapperWithArg({
  env,
  context,
  mapperVarName,
  argValue,
  argType,
  token,
}: {
  env: Environment;
  context: EvaluatorContext;
  mapperVarName: string;
  argValue: Value;
  argType: Type;
  token: Expr["token"];
}): { exprValue: Expr; env: Environment } {
  const argVarName = `__derive_arg_${generateVarialeId(env.modulePath, "da")}`;
  env = addComptimeTempVar({
    env,
    name: argVarName,
    type: argType,
    value: argValue,
  });

  const callCode = `${mapperVarName}(${argVarName})`;
  const callExpr = generateExprFromCode(callCode);
  const result = evaluateExpression({
    expr: callExpr,
    env,
    context: { ...context, forceCompileTimeBindings: true },
  });

  if (!result.$ || !isExprValue(result.$.value)) {
    throw formatErrorMessage({
      token,
      errorMessage: `derive mapper function must return comptime(Expr), got: ${result.$ ? exprToString(result) : "nothing"}`,
    });
  }

  return { exprValue: result.$.value.value, env: result.$.env };
}

/**
 * Helper: combine a list of Expr values with a binary operator Expr (left-associative).
 * e.g., [a, b, c] with op && → ((a && b) && c)
 */
function combineExprsWithOperator(exprs: Expr[], combinerExpr: Expr): Expr {
  if (exprs.length === 0) {
    throw new Error("combineExprsWithOperator: empty exprs list");
  }
  if (exprs.length === 1) {
    return exprs[0]!;
  }

  let result = exprs[0]!;
  for (let i = 1; i < exprs.length; i++) {
    result = {
      tag: ExprTag.FnCall,
      func: {
        tag: ExprTag.Atom,
        token: combinerExpr.token,
      },
      args: [result, exprs[i]!],
      isInfix: true,
      token: combinerExpr.token,
    };
  }
  return result;
}

/**
 * __yo_type_join_fields(T, mapper, combiner) -> comptime(Expr)
 *
 * Iterates struct fields. For each field, calls mapper(FieldInfo) to get an Expr.
 * Combines all Exprs with the combiner operator (left-associative).
 */
export function evaluateTypeJoinFields({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_type_join_fields, 3);

  // Evaluate T
  const typeArg = evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: { ...context },
  });
  if (!typeArg.$ || !isTypeValue(typeArg.$.value)) {
    throw formatErrorMessage({
      token: expr.args[0]!.token,
      errorMessage: `__yo_type_join_fields: first argument must be a Type`,
    });
  }
  env = typeArg.$.env;
  const targetType = typeArg.$.value.value;

  // SomeType → return UnknownValue(Expr)
  if (isSomeType(targetType)) {
    const value = createUnknownValue(createExprType(), { env, context });
    expr.$ = { env, type: value.type, value, pathCollection: [] };
    return expr;
  }

  if (!isStructType(targetType)) {
    throw formatErrorMessage({
      token: expr.args[0]!.token,
      errorMessage: `__yo_type_join_fields: expected a struct type, got: ${typeToString(targetType)}`,
    });
  }

  // Evaluate mapper (should be a function value)
  const mapperArg = evaluateExpression({
    expr: expr.args[1]!,
    env,
    context: { ...context },
  });
  if (!mapperArg.$ || !isFunctionValue(mapperArg.$.value)) {
    throw formatErrorMessage({
      token: expr.args[1]!.token,
      errorMessage: `__yo_type_join_fields: second argument must be a function`,
    });
  }
  env = mapperArg.$.env;
  const mapperValue = mapperArg.$.value;
  const mapperVarName = `__derive_mapper_${generateVarialeId(env.modulePath, "dm")}`;

  // Evaluate combiner (should be an Expr)
  const combinerArg = evaluateExpression({
    expr: expr.args[2]!,
    env,
    context: { ...context },
  });
  if (!combinerArg.$ || !isExprValue(combinerArg.$.value)) {
    throw formatErrorMessage({
      token: expr.args[2]!.token,
      errorMessage: `__yo_type_join_fields: third argument must be a quoted expression (e.g., quote(&&))`,
    });
  }
  env = combinerArg.$.env;
  const combinerExpr = combinerArg.$.value.value;

  // Push a new env frame for temp variables
  env = pushEnvFrame(env);

  // Bind the mapper to a temp var
  env = addComptimeTempVar({
    env,
    name: mapperVarName,
    type: mapperArg.$.type,
    value: mapperValue,
  });

  const resultExprs: Expr[] = [];
  const structType = targetType as StructType;

  for (let i = 0; i < structType.fields.length; i++) {
    const field = structType.fields[i]!;
    const { value: fieldInfoValue, env: env2 } = createFieldInfoValue(
      env,
      field.label,
      field.type,
      context
    );
    env = env2;

    const { exprValue, env: env3 } = callMapperWithArg({
      env,
      context,
      mapperVarName,
      argValue: fieldInfoValue,
      argType: fieldInfoValue.type,
      token: expr.args[1]!.token,
    });
    env = env3;
    resultExprs.push(exprValue);
  }

  // Pop the temp frame
  env = popEnvFrame(env, true);

  if (resultExprs.length === 0) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `__yo_type_join_fields: struct has no fields`,
    });
  }

  const combinedExpr = combineExprsWithOperator(resultExprs, combinerExpr);
  const exprValue = createExprValue(combinedExpr);

  expr.$ = {
    env,
    type: exprValue.type,
    value: exprValue,
    pathCollection: [],
  };
  return expr;
}

/**
 * __yo_type_map_variants(T, mapper) -> comptime(ComptimeList(Expr))
 *
 * Iterates enum variants. For each variant, calls mapper(VariantInfo) to get an Expr.
 * Returns a ComptimeList(Expr) for use with unquote_splicing.
 */
export function evaluateTypeMapVariants({
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
    BuiltinFunctions.__yo_type_map_variants,
    2
  );

  // Evaluate T
  const typeArg = evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: { ...context },
  });
  if (!typeArg.$ || !isTypeValue(typeArg.$.value)) {
    throw formatErrorMessage({
      token: expr.args[0]!.token,
      errorMessage: `__yo_type_map_variants: first argument must be a Type`,
    });
  }
  env = typeArg.$.env;
  const targetType = typeArg.$.value.value;

  // SomeType → return UnknownValue
  if (isSomeType(targetType)) {
    const value = createUnknownValue(createExprType(), { env, context });
    expr.$ = { env, type: value.type, value, pathCollection: [] };
    return expr;
  }

  if (!isEnumType(targetType)) {
    throw formatErrorMessage({
      token: expr.args[0]!.token,
      errorMessage: `__yo_type_map_variants: expected an enum type, got: ${typeToString(targetType)}`,
    });
  }

  // Evaluate mapper
  const mapperArg = evaluateExpression({
    expr: expr.args[1]!,
    env,
    context: { ...context },
  });
  if (!mapperArg.$ || !isFunctionValue(mapperArg.$.value)) {
    throw formatErrorMessage({
      token: expr.args[1]!.token,
      errorMessage: `__yo_type_map_variants: second argument must be a function`,
    });
  }
  env = mapperArg.$.env;
  const mapperValue = mapperArg.$.value;
  const mapperVarName = `__derive_vmap_${generateVarialeId(env.modulePath, "dvm")}`;

  const enumType = targetType as EnumType;

  // Push temp frame
  env = pushEnvFrame(env);

  // Bind mapper
  env = addComptimeTempVar({
    env,
    name: mapperVarName,
    type: mapperArg.$.type,
    value: mapperValue,
  });

  const resultExprs: Value[] = [];

  for (let i = 0; i < enumType.variants.length; i++) {
    const variant = enumType.variants[i]!;
    const { value: variantInfoValue, env: env2 } = createVariantInfoValue(
      env,
      variant.name,
      variant.fields?.length ?? 0,
      targetType,
      i,
      context
    );
    env = env2;

    const { exprValue, env: env3 } = callMapperWithArg({
      env,
      context,
      mapperVarName,
      argValue: variantInfoValue,
      argType: variantInfoValue.type,
      token: expr.args[1]!.token,
    });
    env = env3;
    resultExprs.push(createExprValue(exprValue));
  }

  // Pop temp frame
  env = popEnvFrame(env, true);

  const listExprValue = createExprListValue(resultExprs);
  expr.$ = {
    env,
    type: listExprValue.type,
    value: listExprValue,
    pathCollection: [],
  };
  return expr;
}

/**
 * __yo_type_join_variants(T, mapper, combiner) -> comptime(Expr)
 *
 * Like map_variants but combines results with a binary combiner operator.
 */
export function evaluateTypeJoinVariants({
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
    BuiltinFunctions.__yo_type_join_variants,
    3
  );

  // Evaluate T
  const typeArg = evaluateExpression({
    expr: expr.args[0]!,
    env,
    context: { ...context },
  });
  if (!typeArg.$ || !isTypeValue(typeArg.$.value)) {
    throw formatErrorMessage({
      token: expr.args[0]!.token,
      errorMessage: `__yo_type_join_variants: first argument must be a Type`,
    });
  }
  env = typeArg.$.env;
  const targetType = typeArg.$.value.value;

  if (isSomeType(targetType)) {
    const value = createUnknownValue(createExprType(), { env, context });
    expr.$ = { env, type: value.type, value, pathCollection: [] };
    return expr;
  }

  if (!isEnumType(targetType)) {
    throw formatErrorMessage({
      token: expr.args[0]!.token,
      errorMessage: `__yo_type_join_variants: expected an enum type, got: ${typeToString(targetType)}`,
    });
  }

  // Evaluate mapper
  const mapperArg = evaluateExpression({
    expr: expr.args[1]!,
    env,
    context: { ...context },
  });
  if (!mapperArg.$ || !isFunctionValue(mapperArg.$.value)) {
    throw formatErrorMessage({
      token: expr.args[1]!.token,
      errorMessage: `__yo_type_join_variants: second argument must be a function`,
    });
  }
  env = mapperArg.$.env;
  const mapperValue = mapperArg.$.value;
  const mapperVarName = `__derive_vjmap_${generateVarialeId(env.modulePath, "dvjm")}`;

  // Evaluate combiner
  const combinerArg = evaluateExpression({
    expr: expr.args[2]!,
    env,
    context: { ...context },
  });
  if (!combinerArg.$ || !isExprValue(combinerArg.$.value)) {
    throw formatErrorMessage({
      token: expr.args[2]!.token,
      errorMessage: `__yo_type_join_variants: third argument must be a quoted expression`,
    });
  }
  env = combinerArg.$.env;
  const combinerExpr = combinerArg.$.value.value;

  const enumType = targetType as EnumType;

  // Push temp frame
  env = pushEnvFrame(env);

  env = addComptimeTempVar({
    env,
    name: mapperVarName,
    type: mapperArg.$.type,
    value: mapperValue,
  });

  const resultExprs: Expr[] = [];

  for (let i = 0; i < enumType.variants.length; i++) {
    const variant = enumType.variants[i]!;
    const { value: variantInfoValue, env: env2 } = createVariantInfoValue(
      env,
      variant.name,
      variant.fields?.length ?? 0,
      targetType,
      i,
      context
    );
    env = env2;

    const { exprValue, env: env3 } = callMapperWithArg({
      env,
      context,
      mapperVarName,
      argValue: variantInfoValue,
      argType: variantInfoValue.type,
      token: expr.args[1]!.token,
    });
    env = env3;
    resultExprs.push(exprValue);
  }

  env = popEnvFrame(env, true);

  if (resultExprs.length === 0) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `__yo_type_join_variants: enum has no variants`,
    });
  }

  const combinedExpr = combineExprsWithOperator(resultExprs, combinerExpr);
  const exprValue = createExprValue(combinedExpr);

  expr.$ = {
    env,
    type: exprValue.type,
    value: exprValue,
    pathCollection: [],
  };
  return expr;
}

/**
 * Helper: create a VariantInfo struct value for a given enum variant.
 */
function createVariantInfoValue(
  env: Environment,
  variantName: string,
  fieldCount: number,
  enumType: Type,
  variantIndex: number,
  context: EvaluatorContext
): { value: Value; env: Environment } {
  const tempEnumTypeName = `__derive_et_${generateVarialeId(env.modulePath, "det")}`;
  env = addComptimeTempVar({
    env,
    name: tempEnumTypeName,
    type: createTypeValue(enumType).type,
    value: createTypeValue(enumType),
  });

  const escapedName = JSON.stringify(variantName);
  const code = `VariantInfo(${escapedName}, ${fieldCount}, ${tempEnumTypeName}, ${variantIndex})`;
  const callExpr = generateExprFromCode(code);
  const result = evaluateExpression({
    expr: callExpr,
    env,
    context: { ...context, forceCompileTimeBindings: true },
  });

  if (!result.$ || !result.$.value) {
    throw new Error(
      `Failed to create VariantInfo for variant "${variantName}"`
    );
  }

  return { value: result.$.value, env: result.$.env };
}

/**
 * Helper: create a ComptimeListValue from a list of Values.
 */
function createExprListValue(elements: Value[]) {
  return createComptimeListValueFn(createExprType(), elements);
}
