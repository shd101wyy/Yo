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
  createComptimeStringType,
  createExprType,
} from "../../types/creators";
import type {
  EnumType,
  FunctionParameter,
  StructType,
  TraitType,
  Type,
  FunctionType,
  ArrayType,
  PtrType,
  IsoType,
  DynType,
  SomeType as SomeTypeT,
  TupleType,
  UnionType,
  TypeHierarchyType,
  ComptimeListType,
  TypeField,
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
  createComptimeStringValue,
  createExprValue,
  createTypeValue,
  createUnknownValue,
  createComptimeListValue as createComptimeListValueFn,
  isComptimeStringValue,
  isExprValue,
  isFunctionValue,
  isNumberValue,
  isTypeValue,
  type Value,
} from "../../value";
import type { TypeValue } from "../../type-value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { typeImplementsTraitBool } from "../trait-checking";
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

export function evaluateYoAreTypesEqual({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const args = expr.args;
  const typeArgA = args[0]!;
  const typeArgB = args[1]!;

  const evaluatedA = evaluateExpression({
    expr: typeArgA,
    env,
    context: {
      ...context,
      expectedType: undefined,
      SelfType: undefined,
    },
  });
  if (!isTypeValue(evaluatedA.$?.value)) {
    throw formatErrorMessage({
      token: typeArgA.token,
      errorMessage: `Expected type, got:\n${exprToString(typeArgA)}`,
    });
  }
  const typeA = evaluatedA.$.value.value;
  env = evaluatedA.$.env;

  const evaluatedB = evaluateExpression({
    expr: typeArgB,
    env,
    context: {
      ...context,
      expectedType: undefined,
      SelfType: undefined,
    },
  });
  if (!isTypeValue(evaluatedB.$?.value)) {
    throw formatErrorMessage({
      token: typeArgB.token,
      errorMessage: `Expected type, got:\n${exprToString(typeArgB)}`,
    });
  }
  const typeB = evaluatedB.$.value.value;
  env = evaluatedB.$.env;

  // Check if the types are exactly equal (exact match)
  const equal = areTypesCompatible(
    { type: typeA, env },
    { type: typeB, env },
    true // requireExactMatch
  );

  const booleanValue = createBooleanValue(equal);
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
 * This checks if the type's trait has a field whose assignedValue is a StructValue
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
    typeImplementsTraitBool({ targetType, traitType: expectedTraitType, env })
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

/**
 * Maps compiler TypeTag string value to Yo TypeInfo enum variant name.
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
      return "ComptimeStr";
    case TypeTag.Str:
      return "Str";
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
      return "Some";
    case TypeTag.Trait:
      return "Trait";
    case TypeTag.Ptr:
      return "Ptr";
    case TypeTag.Iso:
      return "Iso";
    case TypeTag.Dyn:
      return "Dyn";
    case TypeTag.Expr:
      return "Expr";
    case TypeTag.ComptimeList:
      return "ComptimeList";
    case TypeTag.TypeApplication:
      return "TypeApplication";
    default:
      throw new Error(`Unknown TypeTag: ${tag}`);
  }
}

/**
 * __yo_type_get_info(T) -> comptime(TypeInfo)
 *
 * Returns a TypeInfo enum value with compound data for the given type.
 * Primitive types return fieldless variants, compound types carry metadata.
 */
export function evaluateYoTypeGetInfo({
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
    builtinName: "__yo_type_get_info",
  });

  if (isSomeType(type)) {
    // During SomeType validation, return UnknownValue with TypeInfo type
    const typeInfoExpr = generateExprFromCode("TypeInfo.Unit");
    const typeInfoResult = evaluateExpression({
      expr: typeInfoExpr,
      env: nextEnv,
      context: { ...context, forceCompileTimeBindings: true },
    });
    if (typeInfoResult.$) {
      const value = createUnknownValue(typeInfoResult.$.type, {
        env: nextEnv,
        context,
      });
      expr.$ = { env: nextEnv, type: value.type, value, pathCollection: [] };
    }
    return expr;
  }

  let code: string;
  let evalEnv = nextEnv;

  switch (type.tag) {
    // === Primitive (fieldless) variants ===
    case TypeTag.Unit:
    case TypeTag.Bool:
    case TypeTag.Usize:
    case TypeTag.Isize:
    case TypeTag.U8:
    case TypeTag.I8:
    case TypeTag.U16:
    case TypeTag.I16:
    case TypeTag.U32:
    case TypeTag.I32:
    case TypeTag.U64:
    case TypeTag.I64:
    case TypeTag.F32:
    case TypeTag.F64:
    case TypeTag.ComptimeInt:
    case TypeTag.ComptimeFloat:
    case TypeTag.ComptimeString:
    case TypeTag.Str:
    case TypeTag.Char:
    case TypeTag.Short:
    case TypeTag.UShort:
    case TypeTag.Int:
    case TypeTag.UInt:
    case TypeTag.Long:
    case TypeTag.ULong:
    case TypeTag.LongLong:
    case TypeTag.ULongLong:
    case TypeTag.LongDouble:
    case TypeTag.Void:
    case TypeTag.Expr:
    case TypeTag.TypeApplication: {
      const variantName = typeTagToVariantName(type.tag);
      code = `TypeInfo.${variantName}`;
      break;
    }

    // === Array(element, length) ===
    case TypeTag.Array: {
      const arrType = type as ArrayType;
      const elemTmp = bindTempType(evalEnv, arrType.childType, context);
      evalEnv = elemTmp.env;
      const lengthValue = arrType.length;
      let lengthStr: string;
      if (isNumberValue(lengthValue)) {
        lengthStr = String(lengthValue.value);
      } else {
        lengthStr = "0";
      }
      code = `TypeInfo.Array(${elemTmp.name}, ${lengthStr})`;
      break;
    }

    // === Ptr(pointee) ===
    case TypeTag.Ptr: {
      const ptrType = type as PtrType;
      const childTmp = bindTempType(evalEnv, ptrType.childType, context);
      evalEnv = childTmp.env;
      code = `TypeInfo.Ptr(${childTmp.name})`;
      break;
    }

    // === Iso(child) ===
    case TypeTag.Iso: {
      const isoType = type as IsoType;
      const childTmp = bindTempType(evalEnv, isoType.childType, context);
      evalEnv = childTmp.env;
      code = `TypeInfo.Iso(${childTmp.name})`;
      break;
    }

    // === ComptimeList(element) ===
    case TypeTag.ComptimeList: {
      const clType = type as ComptimeListType;
      const elemTmp = bindTempType(evalEnv, clType.childType, context);
      evalEnv = elemTmp.env;
      code = `TypeInfo.ComptimeList(${elemTmp.name})`;
      break;
    }

    // === Type(level) ===
    case TypeTag.Type: {
      const thType = type as TypeHierarchyType;
      code = `TypeInfo.Type(${thType.level})`;
      break;
    }

    // === Struct(fields, kind) ===
    case TypeTag.Struct: {
      const structType = type as StructType;
      const fieldListTmp = bindTempTypeFieldList(
        evalEnv,
        structType.fields,
        context
      );
      evalEnv = fieldListTmp.env;

      let kindStr: string;
      if (structType.isNewtype) {
        kindStr = "StructKind.NewType";
      } else if (structType.isAtomicRc) {
        kindStr = "StructKind.AtomicObject";
      } else if (structType.isReferenceSemantics) {
        kindStr = "StructKind.Object";
      } else {
        kindStr = "StructKind.Struct";
      }

      code = `TypeInfo.Struct(${fieldListTmp.name}, ${kindStr})`;
      break;
    }

    // === Enum(variants) ===
    case TypeTag.Enum: {
      const enumType = type as EnumType;
      const variantListTmp = bindTempVariantInfoList(
        evalEnv,
        enumType,
        context
      );
      evalEnv = variantListTmp.env;
      code = `TypeInfo.Enum(${variantListTmp.name})`;
      break;
    }

    // === Union(fields) ===
    case TypeTag.Union: {
      const unionType = type as UnionType;
      const fieldListTmp = bindTempTypeFieldList(
        evalEnv,
        unionType.fields,
        context
      );
      evalEnv = fieldListTmp.env;
      code = `TypeInfo.Union(${fieldListTmp.name})`;
      break;
    }

    // === Tuple(fields) ===
    case TypeTag.Tuple: {
      const tupleType = type as TupleType;
      const fieldListTmp = bindTempTypeFieldList(
        evalEnv,
        tupleType.fields,
        context
      );
      evalEnv = fieldListTmp.env;
      code = `TypeInfo.Tuple(${fieldListTmp.name})`;
      break;
    }

    // === Function(info) ===
    case TypeTag.Function: {
      const fnType = type as FunctionType;
      const infoTmp = bindTempFunctionInfo(evalEnv, fnType, context);
      evalEnv = infoTmp.env;
      code = `TypeInfo.Function(${infoTmp.name})`;
      break;
    }

    // === Trait(fields, kind) ===
    case TypeTag.Trait: {
      const traitType = type as TraitType;
      const fieldListTmp = bindTempTraitFieldInfoList(
        evalEnv,
        traitType,
        context
      );
      evalEnv = fieldListTmp.env;

      const kindTmp = bindTempTraitKind(evalEnv, traitType, context);
      evalEnv = kindTmp.env;

      code = `TypeInfo.Trait(${fieldListTmp.name}, ${kindTmp.name})`;
      break;
    }

    // === Dyn(required_traits, negative_traits) ===
    case TypeTag.Dyn: {
      const dynType = type as DynType;
      const reqTmp = bindTempTraitInfoList(
        evalEnv,
        dynType.requiredTraits.map((t) => t.traitType),
        context,
        "req"
      );
      evalEnv = reqTmp.env;
      const negTmp = bindTempTraitInfoList(
        evalEnv,
        dynType.negativeTraits.map((t) => t.traitType),
        context,
        "neg"
      );
      evalEnv = negTmp.env;
      code = `TypeInfo.Dyn(${reqTmp.name}, ${negTmp.name})`;
      break;
    }

    // === SomeType(name, required_traits, negative_traits, resolved_type) ===
    case TypeTag.SomeType: {
      const someType = type as SomeTypeT;
      const escapedName = JSON.stringify(someType.name);
      const reqTmp = bindTempTraitInfoList(
        evalEnv,
        someType.requiredTraits.map((t) => t.traitType),
        context,
        "req"
      );
      evalEnv = reqTmp.env;
      const negTmp = bindTempTraitInfoList(
        evalEnv,
        someType.negativeTraits.map((t) => t.traitType),
        context,
        "neg"
      );
      evalEnv = negTmp.env;

      let resolvedTmp: { name: string; env: Environment };
      if (someType.resolvedConcreteType) {
        resolvedTmp = bindTempType(
          evalEnv,
          someType.resolvedConcreteType,
          context
        );
      } else {
        // unit if unresolved
        resolvedTmp = { name: "unit", env: evalEnv };
      }
      evalEnv = resolvedTmp.env;

      code = `TypeInfo.SomeType(${escapedName}, ${reqTmp.name}, ${negTmp.name}, ${resolvedTmp.name})`;
      break;
    }

    default:
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_type_get_info: unsupported type tag: ${type.tag}`,
      });
  }

  const infoExpr = generateExprFromCode(code);
  const result = evaluateExpression({
    expr: infoExpr,
    env: evalEnv,
    context: { ...context, forceCompileTimeBindings: true },
  });

  if (!result.$ || !result.$.value) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `__yo_type_get_info: failed to create TypeInfo for type tag: ${type.tag}`,
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
 * Helper: bind a Type value to a temp variable and return its name.
 */
function bindTempType(
  env: Environment,
  type: Type,
  _context: EvaluatorContext
): { name: string; env: Environment } {
  const name = `__ti_t_${generateVarialeId(env.modulePath, "tit")}`;
  const tv = createTypeValue(type);
  env = addComptimeTempVar({ env, name, type: tv.type, value: tv });
  return { name, env };
}

/**
 * Helper: build a ComptimeList(TypeFieldInfo) from TypeField[] and bind to temp var.
 */
function bindTempTypeFieldList(
  env: Environment,
  fields: TypeField[],
  context: EvaluatorContext
): { name: string; env: Environment } {
  const fieldValues: Value[] = [];
  for (const field of fields) {
    const fiTmp = bindTempTypeFieldInfoValue(env, field, context);
    env = fiTmp.env;
    fieldValues.push(fiTmp.value);
  }

  return bindComptimeList(env, fieldValues, "TypeFieldInfo", "fl", context);
}

/**
 * Helper: create a single TypeFieldInfo value from a TypeField and bind to temp var.
 */
function bindTempTypeFieldInfoValue(
  env: Environment,
  field: TypeField,
  context: EvaluatorContext
): { name: string; env: Environment; value: Value } {
  const name = `__ti_fi_${generateVarialeId(env.modulePath, "tifi")}`;

  // Bind the field type as a temp var
  const ftTmp = bindTempType(env, field.type, context);
  env = ftTmp.env;

  const escapedLabel = JSON.stringify(field.label);
  const code = `TypeFieldInfo(${escapedLabel}, ${ftTmp.name})`;
  const callExpr = generateExprFromCode(code);
  const result = evaluateExpression({
    expr: callExpr,
    env,
    context: { ...context, forceCompileTimeBindings: true },
  });

  if (!result.$ || !result.$.value) {
    throw new Error(
      `Failed to create TypeFieldInfo for field "${field.label}"`
    );
  }

  const value = result.$.value;
  env = addComptimeTempVar({
    env,
    name,
    type: result.$.type,
    value,
  });

  return { name, env, value };
}

/**
 * Helper: build a ComptimeList(VariantInfo) from EnumType and bind to temp var.
 * Reuses existing VariantInfo struct.
 */
function bindTempVariantInfoList(
  env: Environment,
  enumType: EnumType,
  context: EvaluatorContext
): { name: string; env: Environment } {
  const variantValues: Value[] = [];
  for (let i = 0; i < enumType.variants.length; i++) {
    const variant = enumType.variants[i]!;
    const viResult = createVariantInfoValue(
      env,
      variant.name,
      variant.fields ?? [],
      enumType,
      i,
      context
    );
    env = viResult.env;
    variantValues.push(viResult.value);
  }

  return bindComptimeList(env, variantValues, "VariantInfo", "vl", context);
}

/**
 * Helper: build a FunctionInfo value and bind to temp var.
 */
function bindTempFunctionInfo(
  env: Environment,
  fnType: FunctionType,
  context: EvaluatorContext
): { name: string; env: Environment } {
  const name = `__ti_fni_${generateVarialeId(env.modulePath, "tifni")}`;

  // Build params list
  const paramsTmp = bindTempParamInfoList(
    env,
    fnType.parameters,
    fnType.variadicParameter,
    context
  );
  env = paramsTmp.env;

  // Return type
  const retTmp = bindTempType(env, fnType.return.type, context);
  env = retTmp.env;

  // Forall params
  const forallTmp = bindTempForallParamInfoList(
    env,
    fnType.forallParameters,
    context
  );
  env = forallTmp.env;

  // Implicit params
  const implicitTmp = bindTempImplicitParamInfoList(
    env,
    [] as FunctionParameter[],
    context
  );
  env = implicitTmp.env;

  const isClosureStr = fnType.isClosure ? "true" : "false";

  const code = `FunctionInfo(${paramsTmp.name}, ${retTmp.name}, ${forallTmp.name}, ${implicitTmp.name}, ${isClosureStr})`;
  const callExpr = generateExprFromCode(code);
  const result = evaluateExpression({
    expr: callExpr,
    env,
    context: { ...context, forceCompileTimeBindings: true },
  });

  if (!result.$ || !result.$.value) {
    throw new Error("Failed to create FunctionInfo");
  }

  env = addComptimeTempVar({
    env,
    name,
    type: result.$.type,
    value: result.$.value,
  });

  return { name, env };
}

/**
 * Helper: build a ComptimeList(ParamInfo) from FunctionParameter[] and bind to temp var.
 */
function bindTempParamInfoList(
  env: Environment,
  params: FunctionParameter[],
  variadicParam: FunctionParameter | undefined,
  context: EvaluatorContext
): { name: string; env: Environment } {
  const paramValues: Value[] = [];
  const allParams = variadicParam ? [...params, variadicParam] : params;

  for (const param of allParams) {
    const ptTmp = bindTempType(env, param.type, context);
    env = ptTmp.env;

    const escapedName = JSON.stringify(param.label);
    const isComptime = param.isCompileTimeOnly ? "true" : "false";
    const isQuote = param.isQuote ? "true" : "false";
    const isVariadic = param === variadicParam ? "true" : "false";

    const code = `ParamInfo(${escapedName}, ${ptTmp.name}, ${isComptime}, ${isQuote}, ${isVariadic})`;
    const callExpr = generateExprFromCode(code);
    const result = evaluateExpression({
      expr: callExpr,
      env,
      context: { ...context, forceCompileTimeBindings: true },
    });

    if (!result.$ || !result.$.value) {
      throw new Error(`Failed to create ParamInfo for param "${param.label}"`);
    }

    env = result.$.env;
    paramValues.push(result.$.value);
  }

  return bindComptimeList(env, paramValues, "ParamInfo", "pl", context);
}

/**
 * Helper: build a ComptimeList(ForallParamInfo) and bind to temp var.
 */
function bindTempForallParamInfoList(
  env: Environment,
  params: FunctionParameter[],
  context: EvaluatorContext
): { name: string; env: Environment } {
  const values: Value[] = [];
  for (const param of params) {
    const ptTmp = bindTempType(env, param.type, context);
    env = ptTmp.env;

    const escapedName = JSON.stringify(param.label);
    const code = `ForallParamInfo(${escapedName}, ${ptTmp.name})`;
    const callExpr = generateExprFromCode(code);
    const result = evaluateExpression({
      expr: callExpr,
      env,
      context: { ...context, forceCompileTimeBindings: true },
    });

    if (!result.$ || !result.$.value) {
      throw new Error(
        `Failed to create ForallParamInfo for param "${param.label}"`
      );
    }

    env = result.$.env;
    values.push(result.$.value);
  }

  return bindComptimeList(env, values, "ForallParamInfo", "fpl", context);
}

/**
 * Helper: build a ComptimeList(ImplicitParamInfo) and bind to temp var.
 */
function bindTempImplicitParamInfoList(
  env: Environment,
  params: FunctionParameter[],
  context: EvaluatorContext
): { name: string; env: Environment } {
  const values: Value[] = [];
  for (const param of params) {
    const ptTmp = bindTempType(env, param.type, context);
    env = ptTmp.env;

    const escapedName = JSON.stringify(param.label);
    const code = `ImplicitParamInfo(${escapedName}, ${ptTmp.name})`;
    const callExpr = generateExprFromCode(code);
    const result = evaluateExpression({
      expr: callExpr,
      env,
      context: { ...context, forceCompileTimeBindings: true },
    });

    if (!result.$ || !result.$.value) {
      throw new Error(
        `Failed to create ImplicitParamInfo for param "${param.label}"`
      );
    }

    env = result.$.env;
    values.push(result.$.value);
  }

  return bindComptimeList(env, values, "ImplicitParamInfo", "ipl", context);
}

/**
 * Helper: build a ComptimeList(TraitFieldInfo) from TraitType and bind to temp var.
 */
function bindTempTraitFieldInfoList(
  env: Environment,
  traitType: TraitType,
  context: EvaluatorContext
): { name: string; env: Environment } {
  const values: Value[] = [];
  for (const field of traitType.fields) {
    const ftTmp = bindTempType(env, field.type, context);
    env = ftTmp.env;

    const escapedName = JSON.stringify(field.label);
    const isAssoc = field.unassignedSomeType ? "true" : "false";

    const code = `TraitFieldInfo(${escapedName}, ${ftTmp.name}, ${isAssoc})`;
    const callExpr = generateExprFromCode(code);
    const result = evaluateExpression({
      expr: callExpr,
      env,
      context: { ...context, forceCompileTimeBindings: true },
    });

    if (!result.$ || !result.$.value) {
      throw new Error(
        `Failed to create TraitFieldInfo for field "${field.label}"`
      );
    }

    env = result.$.env;
    values.push(result.$.value);
  }

  return bindComptimeList(env, values, "TraitFieldInfo", "tfl", context);
}

/**
 * Helper: build a TraitKind value and bind to temp var.
 */
function bindTempTraitKind(
  env: Environment,
  traitType: TraitType,
  context: EvaluatorContext
): { name: string; env: Environment } {
  const name = `__ti_tk_${generateVarialeId(env.modulePath, "titk")}`;

  let code: string;
  if (traitType.isFuture) {
    const childTmp = bindTempType(env, traitType.isFuture.outputType, context);
    env = childTmp.env;

    // Build effects list as ComptimeList(TraitInfo) — 0 or 1 entries.
    const effectTypes = traitType.isFuture.effect
      ? [traitType.isFuture.effect.type]
      : [];
    const effectsTmp = bindTempTraitInfoList(env, effectTypes, context, "eff");
    env = effectsTmp.env;

    code = `TraitKind.Future(${childTmp.name}, ${effectsTmp.name})`;
  } else if (traitType.isFn) {
    const fnInfoTmp = bindTempFunctionInfo(
      env,
      traitType.isFn.callType,
      context
    );
    env = fnInfoTmp.env;
    code = `TraitKind.Fn(${fnInfoTmp.name})`;
  } else {
    code = `TraitKind.Normal`;
  }

  const callExpr = generateExprFromCode(code);
  const result = evaluateExpression({
    expr: callExpr,
    env,
    context: { ...context, forceCompileTimeBindings: true },
  });

  if (!result.$ || !result.$.value) {
    throw new Error("Failed to create TraitKind");
  }

  env = addComptimeTempVar({
    env,
    name,
    type: result.$.type,
    value: result.$.value,
  });

  return { name, env };
}

/**
 * Helper: build a ComptimeList(TraitInfo) from trait types and bind to temp var.
 */
function bindTempTraitInfoList(
  env: Environment,
  traitTypes: Type[],
  context: EvaluatorContext,
  prefix: string
): { name: string; env: Environment } {
  const values: Value[] = [];
  for (const tt of traitTypes) {
    const ttTmp = bindTempType(env, tt, context);
    env = ttTmp.env;

    const code = `TraitInfo(${ttTmp.name})`;
    const callExpr = generateExprFromCode(code);
    const result = evaluateExpression({
      expr: callExpr,
      env,
      context: { ...context, forceCompileTimeBindings: true },
    });

    if (!result.$ || !result.$.value) {
      throw new Error("Failed to create TraitInfo");
    }

    env = result.$.env;
    values.push(result.$.value);
  }

  return bindComptimeList(env, values, "TraitInfo", "trl_" + prefix, context);
}

// ============================================================
// comptime_eval
// ============================================================

/**
 * comptime_eval(code_string) — parse and evaluate a comptime_str as Yo code.
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

  // The argument must be a comptime_str. If it's unknown (SomeType), skip evaluation.
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

/** __yo_comptime_string_to_expr(code : comptime_str) -> comptime(Expr) */
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
      errorMessage: `__yo_comptime_string_to_expr: expected a comptime_str argument`,
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
 * Helper: create a ComptimeList from values and bind to a temp var.
 * Resolves the element type from the first value, or by evaluating a type expression string.
 */
function bindComptimeList(
  env: Environment,
  values: Value[],
  elementTypeName: string,
  varPrefix: string,
  context: EvaluatorContext
): { name: string; env: Environment } {
  let elementType: Type;
  if (values.length > 0) {
    elementType = values[0]!.type;
  } else {
    const typeExpr = generateExprFromCode(elementTypeName);
    const typeResult = evaluateExpression({
      expr: typeExpr,
      env,
      context: { ...context, forceCompileTimeBindings: true },
    });
    if (
      !typeResult.$ ||
      !typeResult.$.value ||
      !isTypeValue(typeResult.$.value)
    ) {
      throw new Error(
        `Failed to resolve type "${elementTypeName}" for empty ComptimeList`
      );
    }
    elementType = (typeResult.$.value as TypeValue).value;
  }

  const name = `__ti_${varPrefix}_${generateVarialeId(env.modulePath, "ti" + varPrefix)}`;
  const listValue = createComptimeListValueFn(elementType, values);
  env = addComptimeTempVar({
    env,
    name,
    type: listValue.type,
    value: listValue,
  });
  return { name, env };
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
      context: { ...context, expectedType: undefined },
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

  // SomeType → return UnknownValue with ComptimeList(Expr) type
  if (isSomeType(targetType)) {
    const dummyListValue = createExprListValue([]);
    const value = createUnknownValue(dummyListValue.type, { env, context });
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
      variant.fields ?? [],
      targetType,
      i,
      context
    );
    env = env2;

    const { exprValue, env: env3 } = callMapperWithArg({
      env,
      context: { ...context, expectedType: undefined },
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
 * Helper: create a VariantInfo struct value for a given enum variant.
 */
function createVariantInfoValue(
  env: Environment,
  variantName: string,
  variantFields: TypeField[],
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

  // Build ComptimeList(TypeFieldInfo) for variant fields
  const fieldsTmp = bindTempTypeFieldList(env, variantFields, context);
  env = fieldsTmp.env;

  const escapedName = JSON.stringify(variantName);
  const code = `VariantInfo(${escapedName}, ${fieldsTmp.name}, ${tempEnumTypeName}, usize(${variantIndex}))`;
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
