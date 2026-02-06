import {
  createEmptyEnv,
  type Environment,
  type Frame,
  getVariablesFromEnv,
} from "../env";
import type { EvaluatorContext } from "../evaluator/context";
import {
  addRcFunctionsToSomeType,
  attachTraitToReceiverType,
} from "../evaluator/types/utils";
import type { Expr } from "../expr";
import type { FunctionValue } from "../function-value";
import { hashString, randomId } from "../utils";
import { isTypeValue, type Value, valueToString } from "../value";
import type {
  ArrayType,
  ComptimeListType,
  DynType,
  EnumType,
  FnTraitType,
  FunctionForallParameter,
  FunctionParameter,
  FunctionParameterExprs,
  FunctionReturn,
  FunctionType,
  FutureTraitType,
  IsoType,
  ModuleType,
  PtrType,
  SliceType,
  SomeType,
  StructType,
  TraitType,
  TupleType,
  Type,
  TypeField,
  TypeHierarchyType,
  UnionType,
  VoidType,
} from "./definitions";
import { getTraitTypeFromEnv } from "./env-lookup";
import { TypeTag } from "./tags";
import { typeToString } from "./utils";

let cachedComptimeIntType: Type | null = null;
export function createComptimeIntType(): Type {
  if (cachedComptimeIntType) {
    return cachedComptimeIntType;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const comptIntType: Type = {
    id: TypeTag.ComptimeInt,
    tag: TypeTag.ComptimeInt,
    trait,
  };
  trait.receiverType = comptIntType;

  cachedComptimeIntType = comptIntType;
  return comptIntType;
}

let cachedComptimeFloatType: Type | null = null;
export function createComptimeFloatType(): Type {
  if (cachedComptimeFloatType) {
    return cachedComptimeFloatType;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.ComptimeFloat,
    tag: TypeTag.ComptimeFloat,
    trait,
  };
  trait.receiverType = type;

  cachedComptimeFloatType = type;
  return type;
}

let cachedComptimeStringType: Type | null = null;
export function createComptimeStringType(): Type {
  if (cachedComptimeStringType) {
    return cachedComptimeStringType;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.ComptimeString,
    tag: TypeTag.ComptimeString,
    trait,
  };
  trait.receiverType = type;

  cachedComptimeStringType = type;
  return type;
}

let cachedExprType: Type | null = null;
export function createExprType(): Type {
  if (cachedExprType) {
    return cachedExprType;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.Expr,
    tag: TypeTag.Expr,
    trait,
  };
  trait.receiverType = type;

  cachedExprType = type;
  return type;
}

const cachedComptimeListTypeMap: Map<Type, ComptimeListType> = new Map();
export function createComptimeListType(childType: Type): ComptimeListType {
  if (cachedComptimeListTypeMap.has(childType)) {
    return cachedComptimeListTypeMap.get(childType)!;
  }
  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const typeId = `comptime_list_${childType.id}`;
  const type: ComptimeListType = {
    id: typeId,
    tag: TypeTag.ComptimeList,
    childType,
    trait,
  };
  trait.receiverType = type;

  cachedComptimeListTypeMap.set(childType, type);

  return type;
}

export function createExprListType(): Type {
  return createComptimeListType(createExprType());
}

let cachedBooleanType: Type | null = null;
export function createBooleanType(): Type {
  if (cachedBooleanType) {
    return cachedBooleanType;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.Bool,
    tag: TypeTag.Bool,
    trait,
  };
  trait.receiverType = type;

  cachedBooleanType = type;
  return type;
}

let cachedUsizeType: Type | null = null;
export function createUsizeType(): Type {
  if (cachedUsizeType) {
    return cachedUsizeType;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.Usize,
    tag: TypeTag.Usize,
    trait,
  };
  trait.receiverType = type;

  cachedUsizeType = type;
  return type;
}

let cachedIsizeType: Type | null = null;
export function createIsizeType(): Type {
  if (cachedIsizeType) {
    return cachedIsizeType;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.Isize,
    tag: TypeTag.Isize,
    trait,
  };
  trait.receiverType = type;

  cachedIsizeType = type;
  return type;
}

let cachedU8Type: Type | null = null;
export function createU8Type(): Type {
  if (cachedU8Type) {
    return cachedU8Type;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.U8,
    tag: TypeTag.U8,
    trait,
  };
  trait.receiverType = type;

  cachedU8Type = type;
  return type;
}

let cachedI8Type: Type | null = null;
export function createI8Type(): Type {
  if (cachedI8Type) {
    return cachedI8Type;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.I8,
    tag: TypeTag.I8,
    trait,
  };
  trait.receiverType = type;

  cachedI8Type = type;
  return type;
}

let cachedU16Type: Type | null = null;
export function createU16Type(): Type {
  if (cachedU16Type) {
    return cachedU16Type;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.U16,
    tag: TypeTag.U16,
    trait,
  };
  trait.receiverType = type;

  cachedU16Type = type;
  return type;
}

let cachedI16Type: Type | null = null;
export function createI16Type(): Type {
  if (cachedI16Type) {
    return cachedI16Type;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.I16,
    tag: TypeTag.I16,
    trait,
  };
  trait.receiverType = type;

  cachedI16Type = type;
  return type;
}

let cachedU32Type: Type | null = null;
export function createU32Type(): Type {
  if (cachedU32Type) {
    return cachedU32Type;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.U32,
    tag: TypeTag.U32,
    trait,
  };
  trait.receiverType = type;

  cachedU32Type = type;
  return type;
}

let cachedI32Type: Type | null = null;
export function createI32Type(): Type {
  if (cachedI32Type) {
    return cachedI32Type;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.I32,
    tag: TypeTag.I32,
    trait,
  };
  trait.receiverType = type;

  cachedI32Type = type;
  return type;
}

let cachedU64Type: Type | null = null;
export function createU64Type(): Type {
  if (cachedU64Type) {
    return cachedU64Type;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.U64,
    tag: TypeTag.U64,
    trait,
  };
  trait.receiverType = type;

  cachedU64Type = type;
  return type;
}

let cachedI64Type: Type | null = null;
export function createI64Type(): Type {
  if (cachedI64Type) {
    return cachedI64Type;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.I64,
    tag: TypeTag.I64,
    trait,
  };
  trait.receiverType = type;

  cachedI64Type = type;
  return type;
}

let cachedF32Type: Type | null = null;
export function createF32Type(): Type {
  if (cachedF32Type) {
    return cachedF32Type;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.F32,
    tag: TypeTag.F32,
    trait,
  };
  trait.receiverType = type;

  cachedF32Type = type;
  return type;
}

let cachedF64Type: Type | null = null;
export function createF64Type(): Type {
  if (cachedF64Type) {
    return cachedF64Type;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.F64,
    tag: TypeTag.F64,
    trait,
  };
  trait.receiverType = type;

  cachedF64Type = type;
  return type;
}

let cachedUnitType: Type | null = null;
export function createUnitType(): Type {
  if (cachedUnitType) {
    return cachedUnitType;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);
  const type: Type = {
    id: TypeTag.Unit,
    tag: TypeTag.Unit,
    trait,
  };
  trait.receiverType = type;

  cachedUnitType = type;
  return type;
}

let cachedCharType: Type | null = null;
export function createCharType(): Type {
  if (cachedCharType) {
    return cachedCharType;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.Char,
    tag: TypeTag.Char,
    trait,
  };
  trait.receiverType = type;

  cachedCharType = type;
  return type;
}

let cachedShortType: Type | null = null;
export function createShortType(): Type {
  if (cachedShortType) {
    return cachedShortType;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.Short,
    tag: TypeTag.Short,
    trait,
  };
  trait.receiverType = type;

  cachedShortType = type;
  return type;
}

let cachedUShortType: Type | null = null;
export function createUShortType(): Type {
  if (cachedUShortType) {
    return cachedUShortType;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.UShort,
    tag: TypeTag.UShort,
    trait,
  };
  trait.receiverType = type;

  cachedUShortType = type;
  return type;
}

let cachedIntType: Type | null = null;
export function createIntType(): Type {
  if (cachedIntType) {
    return cachedIntType;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.Int,
    tag: TypeTag.Int,
    trait,
  };
  trait.receiverType = type;

  cachedIntType = type;
  return type;
}

let cachedUIntType: Type | null = null;
export function createUIntType(): Type {
  if (cachedUIntType) {
    return cachedUIntType;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.UInt,
    tag: TypeTag.UInt,
    trait,
  };
  trait.receiverType = type;

  cachedUIntType = type;
  return type;
}

let cachedLongType: Type | null = null;
export function createLongType(): Type {
  if (cachedLongType) {
    return cachedLongType;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.Long,
    tag: TypeTag.Long,
    trait,
  };
  trait.receiverType = type;

  cachedLongType = type;
  return type;
}

let cachedULongType: Type | null = null;
export function createULongType(): Type {
  if (cachedULongType) {
    return cachedULongType;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.ULong,
    tag: TypeTag.ULong,
    trait,
  };
  trait.receiverType = type;

  cachedULongType = type;
  return type;
}

let cachedLongLongType: Type | null = null;
export function createLongLongType(): Type {
  if (cachedLongLongType) {
    return cachedLongLongType;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.LongLong,
    tag: TypeTag.LongLong,
    trait,
  };
  trait.receiverType = type;

  cachedLongLongType = type;
  return type;
}

let cachedULongLongType: Type | null = null;
export function createULongLongType(): Type {
  if (cachedULongLongType) {
    return cachedULongLongType;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.ULongLong,
    tag: TypeTag.ULongLong,
    trait,
  };
  trait.receiverType = type;

  cachedULongLongType = type;
  return type;
}

let cachedLongDoubleType: Type | null = null;
export function createLongDoubleType(): Type {
  if (cachedLongDoubleType) {
    return cachedLongDoubleType;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const type: Type = {
    id: TypeTag.LongDouble,
    tag: TypeTag.LongDouble,
    trait,
  };
  trait.receiverType = type;

  cachedLongDoubleType = type;
  return type;
}

export function createType0(baseType?: Type): TypeHierarchyType {
  return createTypeHierarchy(0, baseType);
}

export function createArrayType(childType: Type, length: Value): ArrayType {
  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const arrayType: ArrayType = {
    id: `array_${childType.id + "_" + hashString(valueToString(length))}`,
    tag: TypeTag.Array,
    childType,
    length,
    trait,
  };

  trait.receiverType = arrayType;

  return arrayType;
}

const cachedSliceTypeMap: Map<Type, SliceType> = new Map();
export function createSliceType(childType: Type): SliceType {
  if (cachedSliceTypeMap.has(childType)) {
    return cachedSliceTypeMap.get(childType)!;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const sliceType: SliceType = {
    id: `slice_${childType.id}`,
    tag: TypeTag.Slice,
    childType,
    trait,
  };
  trait.receiverType = sliceType;

  cachedSliceTypeMap.set(childType, sliceType);

  return sliceType;
}

/**
 * Look up the str type from the environment (prelude).
 * Throws an error if str is not found.
 */
export function createStrType(env: Environment): Type {
  const strVariables = getVariablesFromEnv(env, "str");
  const strVariable = strVariables.find(
    (v) => isTypeValue(v.value?.[0]) && v.value![0].type
  );

  if (!strVariable || !isTypeValue(strVariable.value?.[0])) {
    throw new Error(
      "'str' type not found in environment. Make sure prelude is loaded."
    );
  }

  return strVariable.value![0].value;
}

let cachedVoidType: VoidType | undefined = undefined;
export function createVoidType(): VoidType {
  if (cachedVoidType) {
    return cachedVoidType;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const voidType: VoidType = {
    id: TypeTag.Void,
    tag: TypeTag.Void,
    trait,
  };
  trait.receiverType = voidType;

  cachedVoidType = voidType;
  return voidType;
}

export function createTupleType(fields: TypeField[]): TupleType {
  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const tupleType: TupleType = {
    id: `tuple_${fields.map((e) => e.type.id).join("_")}`,
    tag: TypeTag.Tuple,
    // size: totalSize,
    fields,
    trait,
  };
  trait.receiverType = tupleType;

  return tupleType;
}

export function createStructType(
  env: Environment,
  isReferenceSemantics: boolean = false,
  isNewtype: boolean = false
): StructType {
  const trait = createTraitType(env);

  const structType: StructType = {
    id: `struct_${randomId(env.modulePath)}`,
    tag: TypeTag.Struct,
    isReferenceSemantics,
    isNewtype,
    fields: [],
    trait,
    env,
  };

  trait.receiverType = structType;

  return structType;
}

export function createModuleType(env: Environment): ModuleType {
  const moduleType: ModuleType = {
    id: `module_${randomId(env.modulePath)}`,
    tag: TypeTag.Module,
    fields: [],
    env,
    trait: undefined,
  };
  return moduleType;
}

export function createTraitType(env: Environment): TraitType {
  const traitType: TraitType = {
    id: `trait_${randomId(env.modulePath)}`,
    tag: TypeTag.Trait,
    fields: [],
    env,
    trait: undefined,
  };
  return traitType;
}

export function createEnumType(env: Environment): EnumType {
  const trait = createTraitType(env);

  const enumType: EnumType = {
    id: `enum_${randomId(env.modulePath)}`,
    tag: TypeTag.Enum,
    variants: [],
    trait,
    env,
  };

  trait.receiverType = enumType;

  return enumType;
}

export function createUnionType(env: Environment): UnionType {
  const trait = createTraitType(env);

  const unionType: UnionType = {
    id: `union_${randomId(env.modulePath)}`,
    tag: TypeTag.Union,
    fields: [],
    trait,
    env,
  };

  trait.receiverType = unionType;

  return unionType;
}

export function createFunctionType({
  parameters,
  forallParameters,
  variadicParameter,
  whereClauseExprs,
  return_,
  env,
  parametersFrame,
  SelfType,
  ParentFunctionType,
  isClosure,
}: {
  parameters: FunctionParameter[];
  forallParameters: FunctionForallParameter[];
  variadicParameter: FunctionParameter | undefined;
  whereClauseExprs?: Expr[];
  return_: FunctionReturn;
  env: Environment;
  parametersFrame: Frame;
  SelfType?: Type;
  ParentFunctionType?: FunctionType;
  isClosure?: boolean;
}): FunctionType {
  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);

  const functionType: FunctionType = {
    id: `fn_${randomId(env.modulePath)}`,
    tag: TypeTag.Function,
    parameters: parameters,
    forallParameters,
    variadicParameter,
    whereClauseExprs,
    return: return_,
    env,
    parametersFrame,
    SelfType,
    ParentFunctionType,
    trait,
    isClosure,
  };
  trait.receiverType = functionType;

  return functionType;
}

const ptrCache: Map<Type, PtrType> = new Map();
export function createPtrType(childType: Type): PtrType {
  // Check cache
  if (ptrCache.has(childType)) {
    return ptrCache.get(childType)!;
  }

  const emptyEnv = createEmptyEnv();
  const trait = createTraitType(emptyEnv);
  const ptrType: PtrType = {
    id: `ptr_${childType.id}`,
    tag: TypeTag.Ptr,
    childType,
    trait,
  };
  trait.receiverType = ptrType;

  ptrCache.set(childType, ptrType);

  return ptrType;
}

const isoCache: Map<Type, IsoType> = new Map();
export function createIsoType(childType: Type, env: Environment): IsoType {
  // Check cache
  if (isoCache.has(childType)) {
    return isoCache.get(childType)!;
  }

  const trait = createTraitType(env);
  const isoType: IsoType = {
    id: `iso_${childType.id}`,
    tag: TypeTag.Iso,
    childType,
    trait,
    env,
  };
  trait.receiverType = isoType;

  isoCache.set(childType, isoType);

  return isoType;
}

// NOTE: We shouldn't cache the SomeType creation because they can differ by ID and name
export function createSomeType(
  type: TypeHierarchyType,
  variableName: string,
  {
    id,
    requiredTraits,
    negativeTraits,
    recursiveTypeRef,
    env,
    context,
  }: {
    id?: string;
    requiredTraits?: TraitType[];
    negativeTraits?: TraitType[];
    recursiveTypeRef?: {
      functionValue: FunctionValue;
      argValues: Value[];
    };
    env: Environment;
    context: EvaluatorContext;
  }
): SomeType {
  if (type.level !== 0) {
    console.trace();
    throw new Error(
      `createSomeType expects a type with level 0, got level ${type.level}`
    );
  }

  const trait = createTraitType(env);

  // Convert TraitType[] to the new format with frameLevel = -1 (permanent, not from where clause)
  const requiredTraitsWithLevel: {
    traitType: TraitType;
    frameLevel: number;
  }[] = requiredTraits?.map((t) => ({ traitType: t, frameLevel: -1 })) ?? [];
  const negativeTraitsWithLevel: {
    traitType: TraitType;
    frameLevel: number;
  }[] = negativeTraits?.map((t) => ({ traitType: t, frameLevel: -1 })) ?? [];

  const someType: SomeType = {
    id: id ?? `sometype_${randomId(env.modulePath)}`,
    tag: TypeTag.SomeType,
    name: variableName,
    definitionFrameLevel:
      env.frames.length > 0 ? env.frames.length - 1 : undefined,
    parentType: type,
    size: undefined,
    requiredTraits: requiredTraitsWithLevel,
    negativeTraits: negativeTraitsWithLevel,
    trait,
    // Necessary to inherit, like extern types from extern "yo"
    isExtern: type.isExtern,
    externName: type.externName,
    recursiveTypeRef,
  };

  trait.receiverType = someType;

  // Check if "Runtime" trait
  if (getTraitTypeFromEnv(env, "Runtime")) {
    // Attach the Runtime trait to the SomeType
    attachTraitToReceiverType("Runtime", someType, env, context);
  }

  // Add ARC functions to SomeType - these dispatch to resolvedConcreteType at codegen time
  addRcFunctionsToSomeType({
    someType,
    env,
    context: {
      SelfType: someType,
      stdPath: "",
    },
  });

  return someType;
}

// const typeHierarchyTypeCache: {
//   level: number;
//   baseType?: Type;
//   cache: TypeHierarchyType;
// }[] = [];
const cachedTypeMap: Map<
  number,
  Map<Type | undefined, TypeHierarchyType>
> = new Map();
export function createTypeHierarchy(
  level: number,
  baseType?: Type
): TypeHierarchyType {
  // Check if already exists
  if (cachedTypeMap.has(level)) {
    const levelMap = cachedTypeMap.get(level)!;
    if (levelMap.has(baseType)) {
      return levelMap.get(baseType)!;
    }
  } else {
    cachedTypeMap.set(level, new Map());
  }

  const trait = createTraitType(createEmptyEnv());
  const type: TypeHierarchyType = {
    id: `Type(${level})`,
    tag: TypeTag.Type,
    level,
    baseType,
    trait,
  };
  trait.receiverType = type;

  // Cache it
  cachedTypeMap.get(level)!.set(baseType, type);

  return type;
}

export function getFunctionParameterExprs({
  expr,
  labelExpr,
  typeExpr,
  defaultValueExpr,
  assignedValueExpr,
}: {
  expr: Expr;
  labelExpr: Expr | undefined;
  typeExpr: Expr;
  defaultValueExpr: Expr | undefined;
  assignedValueExpr: Expr | undefined;
}): FunctionParameterExprs {
  return {
    expr,
    labelExpr,
    typeExpr,
    defaultValueExpr,
    assignedValueExpr,
  } as FunctionParameterExprs;
}

/**
 * Creates a FnTraitType (callable/closure type).
 * This is a TraitType with isFn set to the function signature.
 */
export function createFnTraitType(
  fnType: FunctionType,
  env: Environment
): FnTraitType {
  const fnTraitId = `fn_trait_${fnType.id}`;
  const trait = createTraitType(env);

  // Set the isFn field to make this a FnTraitType
  trait.isFn = { callType: fnType };
  trait.id = fnTraitId;

  trait.receiverType = undefined;

  return trait as FnTraitType;
}

/**
 * Creates a FutureTraitType (future/async type).
 * This is a ModuleType with isFuture set to the child type.
 */
// Global counter for unique FutureTraitType IDs
// Each async block gets its own FutureTraitType with a unique ID
let futureTraitCounter = 0;
export function createFutureTraitType(
  outputType: Type,
  env: Environment
): FutureTraitType {
  // Create a unique ID for each async block's FutureTraitType
  // This ensures different async blocks with the same output type don't share the same FutureTraitType
  const futureTraitId = `future_trait_${outputType.id}_${futureTraitCounter++}`;
  const trait = createTraitType(env);

  // Set the isFuture field to make this a FutureTraitType
  trait.isFuture = { outputType };
  trait.id = futureTraitId;

  trait.receiverType = undefined;

  return trait as FutureTraitType;
}

/**
 * Create a canonical signature for a module type based on its structure, not its unique ID.
 * This ensures that Dyn types with the same module structure get the same ID.
 */
function createTraitSignature(traitType: TraitType): string {
  const fieldSignatures = traitType.fields.map((field) => {
    // For function types, create a canonical signature
    if (field.type.tag === TypeTag.Function) {
      const fnType = field.type as FunctionType;
      const paramSigs = fnType.parameters
        .map((p) => `${p.label}:${typeToString(p.type)}`)
        .join(",");
      const returnSig = typeToString(fnType.return.type);
      return `${field.label}:(${paramSigs})->${returnSig}`;
    }
    return `${field.label}:${typeToString(field.type)}`;
  });
  return fieldSignatures.join(";");
}

export function createDynType({
  requiredTraits,
  env,
  negativeTraits,
}: {
  requiredTraits: TraitType[];
  env: Environment;
  negativeTraits?: TraitType[];
}): DynType {
  const trait = createTraitType(env);

  // Create a canonical ID based on module structure, not unique IDs
  const moduleSignatures = requiredTraits
    .map((m) => createTraitSignature(m))
    .join("__");
  const negativeSignatures = negativeTraits
    ? negativeTraits.map((m) => createTraitSignature(m)).join("__")
    : "";
  const canonicalId = `dyn_${hashString(moduleSignatures + (negativeSignatures ? `_neg_${negativeSignatures}` : ""))}`;

  const requiredTraitsWithLevel: {
    traitType: TraitType;
    frameLevel: number;
  }[] = requiredTraits.map((t) => ({ traitType: t, frameLevel: -1 })) ?? [];
  const negativeTraitsWithLevel: {
    traitType: TraitType;
    frameLevel: number;
  }[] = negativeTraits?.map((t) => ({ traitType: t, frameLevel: -1 })) ?? [];

  const dynType: DynType = {
    id: canonicalId,
    tag: TypeTag.Dyn,
    requiredTraits: requiredTraitsWithLevel,
    negativeTraits: negativeTraitsWithLevel,
    trait,
    env,
  };

  trait.receiverType = dynType;

  /*
  // QUESTION: From the C codegen, it seems like only the ___dispose is used for the wrapped object
  // So do we still need to have ___dup and ___drop in the module type for the wrapped object?
  // Create a module type that defines the ARC interface for the wrapped object
  // This will be used to call ___dup, ___drop, ___dispose on the inner data
  const wrappedObjectARCModuleTypeExpr = generateExprFromCode(`
  module(
    Self : Type,
    /// ___dup :
    ///   fn(self: Self) -> Self,
    /// ___drop :
    ///   fn(self: Self) -> unit,
    ___dispose :
      fn(self: Self) -> unit
  )
  `);
  const evaluatedWrappedObjectARCModuleTypeExpr = evaluateExpression({
    expr: wrappedObjectARCModuleTypeExpr,
    env,
    context: {
      SelfType: dynType,
      stdPath: "",
    },
  });
  /// get its type value, which should be a ModuleType
  const wrappedObjectARCModuleTypeValue =
    evaluatedWrappedObjectARCModuleTypeExpr.$?.value;
  if (!isTypeValue(wrappedObjectARCModuleTypeValue)) {
    throw new Error(
      `Expected a type value for wrapped object ARC module type.`
    );
  }
  if (!isModuleType(wrappedObjectARCModuleTypeValue.value)) {
    throw new Error(
      `Expected a module type for wrapped object ARC module type.`
    );
  }
  const wrappedObjectARCModuleType = wrappedObjectARCModuleTypeValue.value;

  dynType.requiredTraits = [
    wrappedObjectARCModuleType,
    ...dynType.requiredTraits,
  ];
  */

  return dynType;
}

export function clearAllCachedTypes(): void {
  cachedComptimeIntType = null;
  cachedComptimeFloatType = null;
  cachedComptimeStringType = null;
  cachedExprType = null;
  cachedComptimeListTypeMap.clear();
  cachedBooleanType = null;
  cachedUsizeType = null;
  cachedIsizeType = null;
  cachedU8Type = null;
  cachedI8Type = null;
  cachedU16Type = null;
  cachedI16Type = null;
  cachedU32Type = null;
  cachedI32Type = null;
  cachedU64Type = null;
  cachedI64Type = null;
  cachedF32Type = null;
  cachedF64Type = null;
  cachedUnitType = null;
  cachedCharType = null;
  cachedShortType = null;
  cachedUShortType = null;
  cachedIntType = null;
  cachedUIntType = null;
  cachedLongType = null;
  cachedULongType = null;
  cachedLongLongType = null;
  cachedULongLongType = null;
  cachedLongDoubleType = null;
  cachedSliceTypeMap.clear();
  cachedVoidType = undefined;
  cachedTypeMap.clear();
  // CRITICAL: Clear these caches to prevent memory leaks
  ptrCache.clear();
  isoCache.clear();
}
