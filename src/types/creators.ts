import { Environment, Frame } from "../env";
import { Expr, ExprTag } from "../expr";
import { PlaceholderToken } from "../token";
import { hashString, randomId } from "../utils";
import { createTypeValue, Value, valueToString } from "../value";
import {
  ArrayType,
  EnumType,
  ExprType,
  FunctionParameter,
  FunctionParameterExprs,
  FunctionReturn,
  FunctionType,
  ModuleElement,
  ModuleType,
  MutPtrType,
  MutRefType,
  PtrType,
  RefType,
  SliceType,
  SomeType,
  StructType,
  TupleElement,
  TupleType,
  Type,
  TypeHierarchyType,
  UnionType,
} from "./definitions";
import { TypeTag } from "./tags";

export function createFreeType(baseType?: Type): TypeHierarchyType {
  return {
    id: TypeTag.Free,
    tag: TypeTag.Free,
    level: 0,
    baseType,
  };
}

export function createLinearType(baseType?: Type): TypeHierarchyType {
  return {
    id: TypeTag.Linear,
    tag: TypeTag.Linear,
    level: 0,
    baseType,
  };
}

export function createTypeType(baseType?: Type): TypeHierarchyType {
  return {
    id: "Type(0)",
    tag: TypeTag.Type,
    level: 0,
    baseType,
  };
}

export function createComptIntType(): Type {
  return {
    id: TypeTag.ComptInt,
    tag: TypeTag.ComptInt,
  };
}

export function createComptFloatType(): Type {
  return {
    id: TypeTag.ComptFloat,
    tag: TypeTag.ComptFloat,
  };
}

export function createComptStringType(): Type {
  return {
    id: TypeTag.ComptString,
    tag: TypeTag.ComptString,
  };
}

export function createExprListType(): Type {
  return {
    id: TypeTag.ExprList,
    tag: TypeTag.ExprList,
  };
}

export function createBooleanType(): Type {
  return {
    id: TypeTag.Boolean,
    tag: TypeTag.Boolean,
  };
}

export function createExprType(): ExprType {
  return {
    id: TypeTag.Expr,
    tag: TypeTag.Expr,
  };
}

/**
 * 4 bytes unicode
 */
/*
export function createCharType(): Type {
  return {
    tag: TypeTag.Char,
    // size: 4 * 8, // 4 bytes for unicode character
  };
}
*/

export function createUsizeType(): Type {
  return {
    id: TypeTag.Usize,
    tag: TypeTag.Usize,
  };
}

export function createIsizeType(): Type {
  return {
    id: TypeTag.Isize,
    tag: TypeTag.Isize,
  };
}

export function createU8Type(): Type {
  return {
    id: TypeTag.U8,
    tag: TypeTag.U8,
  };
}

export function createI8Type(): Type {
  return {
    id: TypeTag.I8,
    tag: TypeTag.I8,
  };
}

export function createU16Type(): Type {
  return {
    id: TypeTag.U16,
    tag: TypeTag.U16,
  };
}

export function createI16Type(): Type {
  return {
    id: TypeTag.I16,
    tag: TypeTag.I16,
  };
}

export function createU32Type(): Type {
  return {
    id: TypeTag.U32,
    tag: TypeTag.U32,
  };
}

export function createI32Type(): Type {
  return {
    id: TypeTag.I32,
    tag: TypeTag.I32,
  };
}

export function createU64Type(): Type {
  return {
    id: TypeTag.U64,
    tag: TypeTag.U64,
  };
}

export function createI64Type(): Type {
  return {
    id: TypeTag.I64,
    tag: TypeTag.I64,
  };
}

export function createF32Type(): Type {
  return {
    id: TypeTag.F32,
    tag: TypeTag.F32,
  };
}

export function createF64Type(): Type {
  return {
    id: TypeTag.F64,
    tag: TypeTag.F64,
  };
}

export function createUnitType(): Type {
  return {
    id: TypeTag.Unit,
    tag: TypeTag.Unit,
  };
}

// C Compatible types
export function createCCharType(): Type {
  return {
    id: TypeTag.CChar,
    tag: TypeTag.CChar,
  };
}

export function createCShortType(): Type {
  return {
    id: TypeTag.CShort,
    tag: TypeTag.CShort,
  };
}

export function createCUShortType(): Type {
  return {
    id: TypeTag.CUShort,
    tag: TypeTag.CUShort,
  };
}

export function createCIntType(): Type {
  return {
    id: TypeTag.CInt,
    tag: TypeTag.CInt,
  };
}

export function createCUIntType(): Type {
  return {
    id: TypeTag.CUInt,
    tag: TypeTag.CUInt,
  };
}

export function createCLongType(): Type {
  return {
    id: TypeTag.CLong,
    tag: TypeTag.CLong,
  };
}

export function createCULongType(): Type {
  return {
    id: TypeTag.CULong,
    tag: TypeTag.CULong,
  };
}

export function createCLongLongType(): Type {
  return {
    id: TypeTag.CLongLong,
    tag: TypeTag.CLongLong,
  };
}

export function createCULongLongType(): Type {
  return {
    id: TypeTag.CULongLong,
    tag: TypeTag.CULongLong,
  };
}

export function createCLongDoubleType(): Type {
  return {
    id: TypeTag.CLongDouble,
    tag: TypeTag.CLongDouble,
  };
}

export function createArrayType(elementType: Type, length: Value): ArrayType {
  return {
    id: `array_${elementType.id + "_" + hashString(valueToString(length))}`,
    tag: TypeTag.Array,
    elementType,
    length,
  };
}

export function createSliceType(elementType: Type): SliceType {
  return {
    id: `slice_${elementType.id}`,
    tag: TypeTag.Slice,
    elementType,
    isDynamicSized: true,
  };
}

export function createTupleType(elements: TupleElement[]): TupleType {
  return {
    id: `tuple_${elements.map((e) => e.type.id).join("_")}`,
    tag: TypeTag.Tuple,
    // size: totalSize,
    elements,
  };
}

export function createStructType(env: Environment): StructType {
  const module = createModuleType(env);

  const structType: StructType = {
    id: `struct_${randomId()}`,
    tag: TypeTag.Struct,
    elements: [],
    module,
    env,
  };

  // Add "Self" to struct type module if not already present
  const typeValue = createTypeValue(structType);
  const selfElement: ModuleElement = {
    type: typeValue.type,
    label: "Self",
    isCompileTimeOnly: true,
    isImplicit: false,
    defaultValue: undefined,
    assignedValue: typeValue,
    exprs: {
      expr: {
        tag: ExprTag.Atom,
        token: PlaceholderToken,
      },
    },
  };
  module.elements.push(selfElement);

  return structType;
}

export function createModuleType(env: Environment): ModuleType {
  return {
    id: `module_${randomId()}`,
    tag: TypeTag.Module,
    elements: [],
    env,
  };
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

  // Add "Self" to enum type if not already present
  const typeValue = createTypeValue(enumType);
  const selfElement: ModuleElement = {
    type: typeValue.type,
    label: "Self",
    isCompileTimeOnly: true,
    isImplicit: false,
    defaultValue: undefined,
    assignedValue: typeValue,
    exprs: {
      expr: {
        tag: ExprTag.Atom,
        token: PlaceholderToken,
      },
    },
  };
  module.elements.push(selfElement);

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

  // Add "Self" to struct type if not already present
  const typeValue = createTypeValue(unionType);
  const selfElement: ModuleElement = {
    type: typeValue.type,
    label: "Self",
    isCompileTimeOnly: true,
    isImplicit: false,
    defaultValue: undefined,
    assignedValue: typeValue,
    exprs: {
      expr: {
        tag: ExprTag.Atom,
        token: PlaceholderToken,
      },
    },
  };
  module.elements.push(selfElement);

  return unionType;
}

export function createFunctionType({
  parameters,
  typeParameters,
  implicitParameters,
  variadicParameter,
  return_,
  env,
  parametersFrame,
  SelfType,
  ModuleType,
}: {
  parameters: FunctionParameter[];
  typeParameters: FunctionParameter[];
  implicitParameters: FunctionParameter[];
  variadicParameter: FunctionParameter | undefined;
  return_: FunctionReturn;
  env: Environment;
  parametersFrame: Frame;
  SelfType?: Type;
  ModuleType?: ModuleType;
}): FunctionType {
  return {
    id: `fn_${randomId()}`,
    tag: TypeTag.Function,
    parameters: parameters, // Wrap params in a TupleType
    typeParameters,
    implicitParameters,
    variadicParameter,
    return: return_,
    env,
    parametersFrame,
    SelfType,
    ModuleType,
  };
}

export function createMutPtrType(type: Type): MutPtrType {
  return {
    id: TypeTag.MutPtr,
    tag: TypeTag.MutPtr,
    type,
  };
}

export function createPtrType(type: Type): PtrType {
  return {
    id: TypeTag.Ptr,
    tag: TypeTag.Ptr,
    type,
  };
}

export function createMutRefType(type: Type): MutRefType {
  return {
    id: TypeTag.MutRef,
    tag: TypeTag.MutRef,
    type,
  };
}

export function createRefType(type: Type): RefType {
  return {
    id: TypeTag.Ref,
    tag: TypeTag.Ref,
    type,
  };
}

export function createSomeType(
  type: TypeHierarchyType,
  variableName: string
): SomeType {
  if (type.level !== 0) {
    throw new Error(
      `createSomeType expects a type with level 0, got level ${type.level}`
    );
  }

  return {
    id: `sometype_${randomId()}`,
    tag: TypeTag.SomeType,
    name: variableName,
    parentType: type,
    size: undefined,
  };
}

export function createTypeHierarchy(
  level: number,
  baseType?: Type
): TypeHierarchyType {
  return {
    id: `Type(${level})`,
    tag: TypeTag.Type,
    level,
    baseType,
  };
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
