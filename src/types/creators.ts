import {
  createEmptyEnv,
  createEnvContainingPrelude,
  Environment,
  Frame,
  isEvaluatingPreludeModule,
} from "../env";
import { Expr } from "../expr";
import { hashString, randomId } from "../utils";
import { isNumberValue, Value, valueToString } from "../value";
import {
  ArrayType,
  ClosureType,
  ComptListType,
  DynType,
  EnumType,
  FunctionForallParameter,
  FunctionImplicitParameter,
  FunctionParameter,
  FunctionParameterExprs,
  FunctionReturn,
  FunctionType,
  FutureType,
  ModuleType,
  MutPtrType,
  SliceType,
  SomeType,
  StructType,
  TupleType,
  Type,
  TypeElement,
  TypeHierarchyType,
  UnionType,
  VoidType,
} from "./definitions";
import { addModuleElementsByCode } from "./module_element";
import { TypeTag } from "./tags";

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
export function createComptListType(elementType: Type): ComptListType {
  if (cachedComptListTypeMap.has(elementType)) {
    return cachedComptListTypeMap.get(elementType)!;
  }
  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const typeId = `compt_list_${elementType.id}`;
  const type: ComptListType = {
    id: typeId,
    tag: TypeTag.ComptList,
    elementType,
    module,
  };
  module.receiverType = type;

  cachedComptListTypeMap.set(elementType, type);

  addModuleElementsByCode(module, {
    type_info: `impl(Self, {
      id :: "${typeId}";
      export id;

      tag :: "${TypeTag.ComptList}";
      export tag;

      element_type :: __yo_compt_list_element_type(Self);
      export element_type;
    })`,
    car: `((fn(compt(self): Self) -> compt(__yo_compt_list_element_type(Self)))
    __yo_compt_list_car(self)
  )`,
    cdr: `((fn(compt(self): Self) -> compt(Self))
    __yo_compt_list_cdr(self)
  )`,
    first: `Self.car`,
    rest: `Self.cdr`,
    append: `((fn(compt(self): Self, compt(another): Self) -> compt(Self))
    __yo_compt_list_append(self, another)
  )`,
    length: `((fn(compt(self): Self) -> compt(usize))
    __yo_compt_list_length(self)
  )`,
  });

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
    id: TypeTag.Boolean,
    tag: TypeTag.Boolean,
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

export function createArrayType(elementType: Type, length: Value): ArrayType {
  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const arrayType: ArrayType = {
    id: `array_${elementType.id + "_" + hashString(valueToString(length))}`,
    tag: TypeTag.Array,
    elementType,
    length,
    module,
  };

  module.receiverType = arrayType;

  addModuleElementsByCode(module, {
    length: isNumberValue(length)
      ? `__yo_compt_int_as(${length.value.toString()}, usize)`
      : "__yo_compt_int_as(0, usize)",
  });

  return arrayType;
}

const cachedSliceTypeMap: Map<Type, SliceType> = new Map();
export function createSliceType(elementType: Type): SliceType {
  if (cachedSliceTypeMap.has(elementType)) {
    return cachedSliceTypeMap.get(elementType)!;
  }

  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const sliceType: SliceType = {
    id: `slice_${elementType.id}`,
    tag: TypeTag.Slice,
    elementType,
    module,
  };
  module.receiverType = sliceType;

  cachedSliceTypeMap.set(elementType, sliceType);

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

export function createTupleType(elements: TypeElement[]): TupleType {
  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const tupleType: TupleType = {
    id: `tuple_${elements.map((e) => e.type.id).join("_")}`,
    tag: TypeTag.Tuple,
    // size: totalSize,
    elements,
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
    id: `struct_${randomId()}`,
    tag: TypeTag.Struct,
    isReferenceSemantics,
    isNewtype,
    elements: [],
    module,
    env,
  };

  module.receiverType = structType;

  return structType;
}

export function createModuleType(env: Environment): ModuleType {
  const moduleType: ModuleType = {
    id: `module_${randomId()}`,
    tag: TypeTag.Module,
    elements: [],
    env,
    module: undefined,
  };
  return moduleType;
}

export function createEnumType(env: Environment): EnumType {
  const module = createModuleType(env);

  const enumType: EnumType = {
    id: `enum_${randomId()}`,
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
    id: `union_${randomId()}`,
    tag: TypeTag.Union,
    elements: [],
    module,
    env,
  };

  module.receiverType = unionType;

  return unionType;
}

export function createFunctionType({
  parameters,
  forallParameters,
  implicitParameters,
  variadicParameter,
  return_,
  env,
  parametersFrame,
  SelfType,
  isClosure,
}: {
  parameters: FunctionParameter[];
  forallParameters: FunctionForallParameter[];
  implicitParameters: FunctionImplicitParameter[];
  variadicParameter: FunctionParameter | undefined;
  return_: FunctionReturn;
  env: Environment;
  parametersFrame: Frame;
  SelfType?: Type;
  isClosure?: boolean;
}): FunctionType {
  const emptyEnv = createEmptyEnv();
  const module = createModuleType(emptyEnv);

  const functionType: FunctionType = {
    id: `${isClosure ? "closure" : "fn"}_${randomId()}`,
    tag: TypeTag.Function,
    parameters: parameters, // Wrap params in a TupleType
    forallParameters,
    implicitParameters,
    variadicParameter,
    return: return_,
    env,
    parametersFrame,
    SelfType,
    isClosure: isClosure ?? false,
    module,
  };
  module.receiverType = functionType;

  return functionType;
}

const ptrCache: Map<Type, MutPtrType> = new Map();
export function createMutPtrType(type: Type): MutPtrType {
  // Check cache
  if (!isEvaluatingPreludeModule() && ptrCache.has(type)) {
    return ptrCache.get(type)!;
  }
  const env = isEvaluatingPreludeModule()
    ? createEmptyEnv()
    : createEnvContainingPrelude();
  const module = createModuleType(env);
  const ptrType: MutPtrType = {
    id: `ptr_${type.id}`,
    tag: TypeTag.MutPtr,
    type,
    module,
  };
  module.receiverType = ptrType;

  if (!isEvaluatingPreludeModule()) {
    // NOTE: This has to be set before adding module elements to avoid infinite recursion
    ptrCache.set(type, ptrType);

    // Add
    addModuleElementsByCode(module, {
      Add: `{
      extern "Yo", __yo_ptr_add : (fn(forall(T: Type), ptr : T, offset : usize) -> T);
      impl(Self, Add(usize, Self)(
        (+) : ((lhs, rhs) -> __yo_ptr_add(lhs, rhs))
      ))
    }`,
      Sub: `{
      extern "Yo", __yo_ptr_sub : (fn(forall(T: Type), ptr : T, offset : usize) -> T);
      impl(Self, Sub(usize, Self)(
        (-) : ((lhs, rhs) -> __yo_ptr_sub(lhs, rhs))
      ))
    }`,
      Eq: `{
      extern "Yo",
        __yo_ptr_eq :
          fn(forall(T: Type), ptr1 : T, ptr2 : T) -> boolean,
        __yo_ptr_neq :
          fn(forall(T: Type), ptr1 : T, ptr2 : T) -> boolean
      ;
      impl(Self, Eq(Self)(
        (==) : ((lhs, rhs) -> __yo_ptr_eq(lhs, rhs)),
        (!=) : ((lhs, rhs) -> __yo_ptr_neq(lhs, rhs))
      ))
    }`,
      Ord: `{
      extern "Yo",
        __yo_ptr_lt :
          fn(forall(T: Type), ptr1 : T, ptr2 : T) -> boolean,
        __yo_ptr_lte :
          fn(forall(T: Type), ptr1 : T, ptr2 : T) -> boolean,
        __yo_ptr_gt :
          fn(forall(T: Type), ptr1 : T, ptr2 : T) -> boolean,
        __yo_ptr_gte :
          fn(forall(T: Type), ptr1 : T, ptr2 : T) -> boolean
      ;
      impl(Self, Ord(Self)(
        (<) : ((lhs, rhs) -> __yo_ptr_lt(lhs, rhs)),
        (<=) : ((lhs, rhs) -> __yo_ptr_lte(lhs, rhs)),
        (>) : ((lhs, rhs) -> __yo_ptr_gt(lhs, rhs)),
        (>=) : ((lhs, rhs) -> __yo_ptr_gte(lhs, rhs))
      ))
    }`,
      diff: `{
        extern "Yo",
          __yo_ptr_diff :
            fn(forall(T: Type), ptr1 : T, ptr2 : T) -> isize
        ;
        ((fn(lhs : Self, rhs : Self) -> isize) {
          return __yo_ptr_diff(lhs, rhs);
        })
      }`,
      cast: `{
        extern "Yo",
          __yo_ptr_cast :
            fn(forall(Source: Type), source : Source, compt(Target) : Type) -> Target
        ;
        ((fn(self : Self, compt(Target) : Type) -> Target) {
          return __yo_ptr_cast(self, Target);
        })
      }`,
    });
  }

  return ptrType;
}

// NOTE: We shouldn't cache the SomeType creation because they can differ by ID and name
export function createSomeType(
  type: TypeHierarchyType,
  variableName: string,
  id?: string
): SomeType {
  if (type.level !== 0) {
    console.trace();
    throw new Error(
      `createSomeType expects a type with level 0, got level ${type.level}`
    );
  }

  const module: ModuleType = createModuleType(createEmptyEnv());
  const someType: SomeType = {
    id: id ?? `sometype_${randomId()}`,
    tag: TypeTag.SomeType,
    name: variableName,
    parentType: type,
    size: undefined,
    module,
  };
  module.receiverType = someType;

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
}: {
  expr: Expr;
  labelExpr: Expr | undefined;
  typeExpr: Expr | undefined;
  defaultValueExpr: Expr | undefined;
}): FunctionParameterExprs {
  if (!labelExpr && !typeExpr && !defaultValueExpr) {
    throw new Error(
      `At least one of labelExpr, typeExpr or defaultValueExpr must be defined`
    );
  }
  if (!typeExpr && !defaultValueExpr) {
    throw new Error(
      `Expected either typeExpr or defaultValueExpr to be defined`
    );
  }
  return {
    expr,
    labelExpr,
    typeExpr,
    defaultValueExpr,
  } as FunctionParameterExprs;
}

export function createClosureType(
  callType: FunctionType,
  env: Environment
): ClosureType {
  if (!callType.isClosure) {
    throw new Error(
      `createClosureType expects a FunctionType with isClosure=true, got FunctionType with isClosure=false`
    );
  }

  // Use only call type for closure ID
  const closureId = `closure_${callType.id}`;
  const module = createModuleType(env);

  const closureType: ClosureType = {
    id: closureId,
    tag: TypeTag.Closure,
    callType: callType as FunctionType & { isClosure: true },
    module,
    env,
  };

  module.receiverType = closureType;

  return closureType;
}

export function createDynType(
  moduleTypes: ModuleType[],
  env: Environment
): DynType {
  const module = createModuleType(env);

  const dynType: DynType = {
    id: `dyn_${moduleTypes.map((m) => m.id).join("_")}`,
    tag: TypeTag.Dyn,
    moduleTypes,
    module,
    env,
  };

  module.receiverType = dynType;

  return dynType;
}

export function createFutureType(
  elementType: Type,
  env: Environment
): FutureType {
  const module = createModuleType(env);

  const futureType: FutureType = {
    id: `future_${elementType.id}`,
    tag: TypeTag.Future,
    elementType,
    module,
    env,
  };

  module.receiverType = futureType;

  return futureType;
}
