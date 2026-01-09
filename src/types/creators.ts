import { createEmptyEnv, Environment, Frame } from "../env";
import { addRcFunctionsToSomeType } from "../evaluator/types/utils";
import { Expr } from "../expr";
import { FunctionValue } from "../function-value";
import { hashString, randomId } from "../utils";
import { Value, valueToString } from "../value";
import {
  ArrayType,
  ComptListType,
  DynType,
  EnumType,
  FnModuleType,
  FunctionForallParameter,
  FunctionParameter,
  FunctionParameterExprs,
  FunctionReturn,
  FunctionType,
  FutureModuleType,
  IsoType,
  ModuleType,
  PtrType,
  SliceType,
  SomeType,
  StructType,
  TupleType,
  Type,
  TypeField,
  TypeHierarchyType,
  UnionType,
  VoidType,
} from "./definitions";
import { TypeTag } from "./tags";
import { typeToString } from "./utils";

let cachedComptIntType: Type | null = null;
export function createComptIntType(): Type {
  if (cachedComptIntType) {
    return cachedComptIntType;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const comptIntType: Type = {
    id: TypeTag.ComptInt,
    tag: TypeTag.ComptInt,
    module,
  };
  module.receiverType = comptIntType;

  cachedComptIntType = comptIntType;
  return comptIntType;
}

let cachedComptFloatType: Type | null = null;
export function createComptFloatType(): Type {
  if (cachedComptFloatType) {
    return cachedComptFloatType;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.ComptFloat,
    tag: TypeTag.ComptFloat,
    module,
  };
  module.receiverType = type;

  cachedComptFloatType = type;
  return type;
}

let cachedComptStringType: Type | null = null;
export function createComptStringType(): Type {
  if (cachedComptStringType) {
    return cachedComptStringType;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.ComptString,
    tag: TypeTag.ComptString,
    module,
  };
  module.receiverType = type;

  cachedComptStringType = type;
  return type;
}

let cachedExprType: Type | null = null;
export function createExprType(): Type {
  if (cachedExprType) {
    return cachedExprType;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.Expr,
    tag: TypeTag.Expr,
    module,
  };
  module.receiverType = type;

  cachedExprType = type;
  return type;
}

const cachedComptListTypeMap: Map<Type, ComptListType> = new Map();
export function createComptListType(childType: Type): ComptListType {
  if (cachedComptListTypeMap.has(childType)) {
    return cachedComptListTypeMap.get(childType)!;
  }
  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const typeId = `compt_list_${childType.id}`;
  const type: ComptListType = {
    id: typeId,
    tag: TypeTag.ComptList,
    childType,
    module,
  };
  module.receiverType = type;

  cachedComptListTypeMap.set(childType, type);

  return type;
}

export function createExprListType(): Type {
  return createComptListType(createExprType());
}

let cachedBooleanType: Type | null = null;
export function createBooleanType(): Type {
  if (cachedBooleanType) {
    return cachedBooleanType;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.Bool,
    tag: TypeTag.Bool,
    module,
  };
  module.receiverType = type;

  cachedBooleanType = type;
  return type;
}

let cachedUsizeType: Type | null = null;
export function createUsizeType(): Type {
  if (cachedUsizeType) {
    return cachedUsizeType;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.Usize,
    tag: TypeTag.Usize,
    module,
  };
  module.receiverType = type;

  cachedUsizeType = type;
  return type;
}

let cachedIsizeType: Type | null = null;
export function createIsizeType(): Type {
  if (cachedIsizeType) {
    return cachedIsizeType;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.Isize,
    tag: TypeTag.Isize,
    module,
  };
  module.receiverType = type;

  cachedIsizeType = type;
  return type;
}

let cachedU8Type: Type | null = null;
export function createU8Type(): Type {
  if (cachedU8Type) {
    return cachedU8Type;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.U8,
    tag: TypeTag.U8,
    module,
  };
  module.receiverType = type;

  cachedU8Type = type;
  return type;
}

let cachedI8Type: Type | null = null;
export function createI8Type(): Type {
  if (cachedI8Type) {
    return cachedI8Type;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.I8,
    tag: TypeTag.I8,
    module,
  };
  module.receiverType = type;

  cachedI8Type = type;
  return type;
}

let cachedU16Type: Type | null = null;
export function createU16Type(): Type {
  if (cachedU16Type) {
    return cachedU16Type;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.U16,
    tag: TypeTag.U16,
    module,
  };
  module.receiverType = type;

  cachedU16Type = type;
  return type;
}

let cachedI16Type: Type | null = null;
export function createI16Type(): Type {
  if (cachedI16Type) {
    return cachedI16Type;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.I16,
    tag: TypeTag.I16,
    module,
  };
  module.receiverType = type;

  cachedI16Type = type;
  return type;
}

let cachedU32Type: Type | null = null;
export function createU32Type(): Type {
  if (cachedU32Type) {
    return cachedU32Type;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.U32,
    tag: TypeTag.U32,
    module,
  };
  module.receiverType = type;

  cachedU32Type = type;
  return type;
}

let cachedI32Type: Type | null = null;
export function createI32Type(): Type {
  if (cachedI32Type) {
    return cachedI32Type;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.I32,
    tag: TypeTag.I32,
    module,
  };
  module.receiverType = type;

  cachedI32Type = type;
  return type;
}

let cachedU64Type: Type | null = null;
export function createU64Type(): Type {
  if (cachedU64Type) {
    return cachedU64Type;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.U64,
    tag: TypeTag.U64,
    module,
  };
  module.receiverType = type;

  cachedU64Type = type;
  return type;
}

let cachedI64Type: Type | null = null;
export function createI64Type(): Type {
  if (cachedI64Type) {
    return cachedI64Type;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.I64,
    tag: TypeTag.I64,
    module,
  };
  module.receiverType = type;

  cachedI64Type = type;
  return type;
}

let cachedF32Type: Type | null = null;
export function createF32Type(): Type {
  if (cachedF32Type) {
    return cachedF32Type;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.F32,
    tag: TypeTag.F32,
    module,
  };
  module.receiverType = type;

  cachedF32Type = type;
  return type;
}

let cachedF64Type: Type | null = null;
export function createF64Type(): Type {
  if (cachedF64Type) {
    return cachedF64Type;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.F64,
    tag: TypeTag.F64,
    module,
  };
  module.receiverType = type;

  cachedF64Type = type;
  return type;
}

let cachedUnitType: Type | null = null;
export function createUnitType(): Type {
  if (cachedUnitType) {
    return cachedUnitType;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);
  const type: Type = {
    id: TypeTag.Unit,
    tag: TypeTag.Unit,
    module,
  };
  module.receiverType = type;

  cachedUnitType = type;
  return type;
}

let cachedCharType: Type | null = null;
export function createCharType(): Type {
  if (cachedCharType) {
    return cachedCharType;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.Char,
    tag: TypeTag.Char,
    module,
  };
  module.receiverType = type;

  cachedCharType = type;
  return type;
}

let cachedShortType: Type | null = null;
export function createShortType(): Type {
  if (cachedShortType) {
    return cachedShortType;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.Short,
    tag: TypeTag.Short,
    module,
  };
  module.receiverType = type;

  cachedShortType = type;
  return type;
}

let cachedUShortType: Type | null = null;
export function createUShortType(): Type {
  if (cachedUShortType) {
    return cachedUShortType;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.UShort,
    tag: TypeTag.UShort,
    module,
  };
  module.receiverType = type;

  cachedUShortType = type;
  return type;
}

let cachedIntType: Type | null = null;
export function createIntType(): Type {
  if (cachedIntType) {
    return cachedIntType;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.Int,
    tag: TypeTag.Int,
    module,
  };
  module.receiverType = type;

  cachedIntType = type;
  return type;
}

let cachedUIntType: Type | null = null;
export function createUIntType(): Type {
  if (cachedUIntType) {
    return cachedUIntType;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.UInt,
    tag: TypeTag.UInt,
    module,
  };
  module.receiverType = type;

  cachedUIntType = type;
  return type;
}

let cachedLongType: Type | null = null;
export function createLongType(): Type {
  if (cachedLongType) {
    return cachedLongType;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.Long,
    tag: TypeTag.Long,
    module,
  };
  module.receiverType = type;

  cachedLongType = type;
  return type;
}

let cachedULongType: Type | null = null;
export function createULongType(): Type {
  if (cachedULongType) {
    return cachedULongType;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.ULong,
    tag: TypeTag.ULong,
    module,
  };
  module.receiverType = type;

  cachedULongType = type;
  return type;
}

let cachedLongLongType: Type | null = null;
export function createLongLongType(): Type {
  if (cachedLongLongType) {
    return cachedLongLongType;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.LongLong,
    tag: TypeTag.LongLong,
    module,
  };
  module.receiverType = type;

  cachedLongLongType = type;
  return type;
}

let cachedULongLongType: Type | null = null;
export function createULongLongType(): Type {
  if (cachedULongLongType) {
    return cachedULongLongType;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.ULongLong,
    tag: TypeTag.ULongLong,
    module,
  };
  module.receiverType = type;

  cachedULongLongType = type;
  return type;
}

let cachedLongDoubleType: Type | null = null;
export function createLongDoubleType(): Type {
  if (cachedLongDoubleType) {
    return cachedLongDoubleType;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const type: Type = {
    id: TypeTag.LongDouble,
    tag: TypeTag.LongDouble,
    module,
  };
  module.receiverType = type;

  cachedLongDoubleType = type;
  return type;
}

export function createType0(baseType?: Type): TypeHierarchyType {
  return createTypeHierarchy(0, baseType);
}

export function createArrayType(childType: Type, length: Value): ArrayType {
  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const arrayType: ArrayType = {
    id: `array_${childType.id + "_" + hashString(valueToString(length))}`,
    tag: TypeTag.Array,
    childType,
    length,
    module,
  };

  module.receiverType = arrayType;

  return arrayType;
}

const cachedSliceTypeMap: Map<Type, SliceType> = new Map();
export function createSliceType(childType: Type): SliceType {
  if (cachedSliceTypeMap.has(childType)) {
    return cachedSliceTypeMap.get(childType)!;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const sliceType: SliceType = {
    id: `slice_${childType.id}`,
    tag: TypeTag.Slice,
    childType,
    module,
  };
  module.receiverType = sliceType;

  cachedSliceTypeMap.set(childType, sliceType);

  return sliceType;
}

let cachedVoidType: VoidType | undefined = undefined;
export function createVoidType(): VoidType {
  if (cachedVoidType) {
    return cachedVoidType;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const voidType: VoidType = {
    id: TypeTag.Void,
    tag: TypeTag.Void,
    module,
  };
  module.receiverType = voidType;

  cachedVoidType = voidType;
  return voidType;
}

export function createTupleType(fields: TypeField[]): TupleType {
  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const tupleType: TupleType = {
    id: `tuple_${fields.map((e) => e.type.id).join("_")}`,
    tag: TypeTag.Tuple,
    // size: totalSize,
    fields,
    module,
  };
  module.receiverType = tupleType;

  return tupleType;
}

export function createStructType(
  env: Environment,
  isReferenceSemantics: boolean = false,
  isNewtype: boolean = false
): StructType {
  const module = createModuleType(env);

  const structType: StructType = {
    id: `struct_${randomId(env.modulePath)}`,
    tag: TypeTag.Struct,
    isReferenceSemantics,
    isNewtype,
    fields: [],
    module,
    env,
  };

  module.receiverType = structType;

  return structType;
}

export function createModuleType(env: Environment): ModuleType {
  const moduleType: ModuleType = {
    id: `module_${randomId(env.modulePath)}`,
    tag: TypeTag.Module,
    fields: [],
    env,
    module: undefined,
  };
  return moduleType;
}

export function createEnumType(env: Environment): EnumType {
  const module = createModuleType(env);

  const enumType: EnumType = {
    id: `enum_${randomId(env.modulePath)}`,
    tag: TypeTag.Enum,
    variants: [],
    module,
    env,
  };

  module.receiverType = enumType;

  return enumType;
}

export function createUnionType(env: Environment): UnionType {
  const module: ModuleType = createModuleType(env);

  const unionType: UnionType = {
    id: `union_${randomId(env.modulePath)}`,
    tag: TypeTag.Union,
    fields: [],
    module,
    env,
  };

  module.receiverType = unionType;

  return unionType;
}

export function createFunctionType({
  parameters,
  forallParameters,
  variadicParameter,
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
  return_: FunctionReturn;
  env: Environment;
  parametersFrame: Frame;
  SelfType?: Type;
  ParentFunctionType?: FunctionType;
  isClosure?: boolean;
}): FunctionType {
  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const functionType: FunctionType = {
    id: `fn_${randomId(env.modulePath)}`,
    tag: TypeTag.Function,
    parameters: parameters,
    forallParameters,
    variadicParameter,
    return: return_,
    env,
    parametersFrame,
    SelfType,
    ParentFunctionType,
    module,
    isClosure,
  };
  module.receiverType = functionType;

  return functionType;
}

const ptrCache: Map<Type, PtrType> = new Map();
export function createPtrType(childType: Type): PtrType {
  // Check cache
  if (ptrCache.has(childType)) {
    return ptrCache.get(childType)!;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);
  const ptrType: PtrType = {
    id: `ptr_${childType.id}`,
    tag: TypeTag.Ptr,
    childType,
    module,
  };
  module.receiverType = ptrType;

  ptrCache.set(childType, ptrType);

  return ptrType;
}

const isoCache: Map<Type, IsoType> = new Map();
export function createIsoType(childType: Type, env: Environment): IsoType {
  // Check cache
  if (isoCache.has(childType)) {
    return isoCache.get(childType)!;
  }

  const module = createModuleType(env);
  const isoType: IsoType = {
    id: `iso_${childType.id}`,
    tag: TypeTag.Iso,
    childType,
    module,
    env,
  };
  module.receiverType = isoType;

  isoCache.set(childType, isoType);

  return isoType;
}

// NOTE: We shouldn't cache the SomeType creation because they can differ by ID and name
export function createSomeType(
  type: TypeHierarchyType,
  variableName: string,
  id?: string,
  requiredModules?: ModuleType[],
  negativeModules?: ModuleType[],
  recursiveTypeRef?: {
    functionValue: FunctionValue;
    argValues: Value[];
  },
  env?: Environment
): SomeType {
  if (type.level !== 0) {
    console.trace();
    throw new Error(
      `createSomeType expects a type with level 0, got level ${type.level}`
    );
  }

  const emptyEnv = env ?? createEmptyEnv();
  const module: ModuleType = createModuleType(emptyEnv);

  const someType: SomeType = {
    id: id ?? `sometype_${randomId(emptyEnv.modulePath)}`,
    tag: TypeTag.SomeType,
    name: variableName,
    parentType: type,
    size: undefined,
    requiredModules: requiredModules ?? [],
    negativeModules:
      negativeModules && negativeModules.length > 0
        ? negativeModules
        : undefined,
    module,
    // Necessary to inherit, like extern types from extern "yo"
    isExtern: type.isExtern,
    externName: type.externName,
    recursiveTypeRef,
  };
  module.receiverType = someType;

  // Add ARC functions to SomeType - these dispatch to resolvedConcreteType at codegen time
  addRcFunctionsToSomeType({
    someType,
    env: emptyEnv,
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

  const module: ModuleType = createModuleType(createEmptyEnv());
  const type: TypeHierarchyType = {
    id: `Type(${level})`,
    tag: TypeTag.Type,
    level,
    baseType,
    module,
  };
  module.receiverType = type;

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
  typeExpr: Expr | undefined;
  defaultValueExpr: Expr | undefined;
  assignedValueExpr: Expr | undefined;
}): FunctionParameterExprs {
  if (!labelExpr && !typeExpr && !defaultValueExpr && !assignedValueExpr) {
    throw new Error(
      `At least one of labelExpr, typeExpr, defaultValueExpr or assignedValueExpr must be defined`
    );
  }
  if (!typeExpr && !defaultValueExpr && !assignedValueExpr) {
    throw new Error(
      `Expected either typeExpr, defaultValueExpr or assignedValueExpr to be defined`
    );
  }
  return {
    expr,
    labelExpr,
    typeExpr,
    defaultValueExpr,
    assignedValueExpr,
  } as FunctionParameterExprs;
}

/**
 * Creates a FnModuleType (callable/closure type).
 * This is a ModuleType with isFn set to the function signature.
 */
export function createFnModuleType(
  fnType: FunctionType,
  env: Environment
): FnModuleType {
  const fnModuleId = `fn_module_${fnType.id}`;
  const module = createModuleType(env);

  // Set the isFn field to make this a FnModuleType
  module.isFn = { callType: fnType };
  module.id = fnModuleId;

  module.receiverType = undefined;

  return module as FnModuleType;
}

/**
 * Creates a FutureModuleType (future/async type).
 * This is a ModuleType with isFuture set to the child type.
 */
// Global counter for unique FutureModuleType IDs
// Each async block gets its own FutureModuleType with a unique ID
let futureModuleCounter = 0;

export function createFutureModuleType(
  outputType: Type,
  env: Environment
): FutureModuleType {
  // Create a unique ID for each async block's FutureModuleType
  // This ensures different async blocks with the same output type don't share the same FutureModuleType
  const futureModuleId = `future_module_${outputType.id}_${futureModuleCounter++}`;
  const module = createModuleType(env);

  // Set the isFuture field to make this a FutureModuleType
  module.isFuture = { outputType };
  module.id = futureModuleId;

  module.receiverType = undefined;

  return module as FutureModuleType;
}

/**
 * Create a canonical signature for a module type based on its structure, not its unique ID.
 * This ensures that Dyn types with the same module structure get the same ID.
 */
function createModuleSignature(moduleType: ModuleType): string {
  const fieldSignatures = moduleType.fields.map((field) => {
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

export function createDynType(
  requiredModules: ModuleType[],
  env: Environment,
  negativeModules?: ModuleType[]
): DynType {
  const module = createModuleType(env);

  // Create a canonical ID based on module structure, not unique IDs
  const moduleSignatures = requiredModules
    .map((m) => createModuleSignature(m))
    .join("__");
  const negativeSignatures = negativeModules
    ? negativeModules.map((m) => createModuleSignature(m)).join("__")
    : "";
  const canonicalId = `dyn_${hashString(moduleSignatures + (negativeSignatures ? `_neg_${negativeSignatures}` : ""))}`;

  const dynType: DynType = {
    id: canonicalId,
    tag: TypeTag.Dyn,
    requiredModules: [...requiredModules],
    negativeModules:
      negativeModules && negativeModules.length > 0
        ? negativeModules
        : undefined,
    module,
    env,
  };

  module.receiverType = dynType;

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

  dynType.requiredModules = [
    wrappedObjectARCModuleType,
    ...dynType.requiredModules,
  ];
  */

  return dynType;
}

export function clearAllCachedTypes(): void {
  cachedComptIntType = null;
  cachedComptFloatType = null;
  cachedComptStringType = null;
  cachedExprType = null;
  cachedComptListTypeMap.clear();
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
