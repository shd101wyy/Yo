import { Environment, Frame } from "../env";
import { Expr, ExprTag } from "../expr";
import { PlaceholderToken } from "../token";
import { randomId } from "../utils";
import { createTypeValue, Value } from "../value";
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
  StructType,
  TupleElement,
  TupleType,
  Type,
  TypeHierarchyType,
  UnionType,
} from "./definitions";
import { TypeTag } from "./tags";

// FIXME: We need to determine the ptr size based on the givenType architecture.
/**
 * @returns The size of a pointer in bytes.
 */
export function getPtrSize(): number {
  return 8;
}

export function createFreeType(baseType?: Type): TypeHierarchyType {
  return {
    tag: TypeTag.Free,
    level: 0,
    baseType,
  };
}

export function createLinearType(baseType?: Type): TypeHierarchyType {
  return {
    tag: TypeTag.Linear,
    level: 0,
    baseType,
  };
}

export function createTypeType(baseType?: Type): TypeHierarchyType {
  return {
    tag: TypeTag.Type,
    level: 0,
    baseType,
  };
}

export function createComptIntType(): Type {
  return {
    tag: TypeTag.ComptInt,
  };
}

export function createComptFloatType(): Type {
  return {
    tag: TypeTag.ComptFloat,
  };
}

export function createComptStringType(): Type {
  return {
    tag: TypeTag.ComptString,
  };
}

export function createExprListType(): Type {
  return {
    tag: TypeTag.ExprList,
  };
}

export function createBooleanType(): Type {
  return {
    tag: TypeTag.Boolean,
  };
}

export function createExprType(): ExprType {
  return {
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
    tag: TypeTag.Usize,
  };
}

export function createIsizeType(): Type {
  return {
    tag: TypeTag.Isize,
  };
}

export function createU8Type(): Type {
  return {
    tag: TypeTag.U8,
  };
}

export function createI8Type(): Type {
  return {
    tag: TypeTag.I8,
  };
}

export function createU16Type(): Type {
  return {
    tag: TypeTag.U16,
  };
}

export function createI16Type(): Type {
  return {
    tag: TypeTag.I16,
  };
}

export function createU32Type(): Type {
  return {
    tag: TypeTag.U32,
  };
}

export function createI32Type(): Type {
  return {
    tag: TypeTag.I32,
  };
}

export function createU64Type(): Type {
  return {
    tag: TypeTag.U64,
  };
}

export function createI64Type(): Type {
  return {
    tag: TypeTag.I64,
  };
}

export function createF32Type(): Type {
  return {
    tag: TypeTag.F32,
  };
}

export function createF64Type(): Type {
  return {
    tag: TypeTag.F64,
  };
}

export function createUnitType(): Type {
  return {
    tag: TypeTag.Unit,
  };
}

// C Compatible types
export function createCCharType(): Type {
  return {
    tag: TypeTag.CChar,
  };
}

export function createCShortType(): Type {
  return {
    tag: TypeTag.CShort,
  };
}

export function createCUShortType(): Type {
  return {
    tag: TypeTag.CUShort,
  };
}

export function createCIntType(): Type {
  return {
    tag: TypeTag.CInt,
  };
}

export function createCUIntType(): Type {
  return {
    tag: TypeTag.CUInt,
  };
}

export function createCLongType(): Type {
  return {
    tag: TypeTag.CLong,
  };
}

export function createCULongType(): Type {
  return {
    tag: TypeTag.CULong,
  };
}

export function createCLongLongType(): Type {
  return {
    tag: TypeTag.CLongLong,
  };
}

export function createCULongLongType(): Type {
  return {
    tag: TypeTag.CULongLong,
  };
}

export function createCLongDoubleType(): Type {
  return {
    tag: TypeTag.CLongDouble,
  };
}

// Type constructor functions (need to be updated to include kind)
export function createArrayType(elementType: Type, length: Value): ArrayType {
  return {
    tag: TypeTag.Array,
    elementType,
    length,
  };
}

export function createTupleType(elements: TupleElement[]): TupleType {
  return {
    tag: TypeTag.Tuple,
    // size: totalSize,
    elements,
  };
}

export function createStructType(
  env: Environment,
  typeId?: string
): StructType {
  const module = createModuleType(env);

  const structType: StructType = {
    tag: TypeTag.Struct,
    elements: [],
    module,
    env,
    typeId: typeId ?? `struct_${randomId()}`,
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
    tag: TypeTag.Module,
    elements: [],
    env,
  };
}

export function createEnumType(env: Environment, typeId?: string): EnumType {
  const module = createModuleType(env);

  const enumType: EnumType = {
    tag: TypeTag.Enum,
    variants: [],
    module,
    env,
    typeId: typeId ?? `enum_${randomId()}`,
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

export function createUnionType(env: Environment, typeId?: string): UnionType {
  const module: ModuleType = createModuleType(env);

  const unionType: UnionType = {
    tag: TypeTag.Union,
    elements: [],
    module,
    env,
    typeId: typeId ?? `union_${randomId()}`,
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
  return_,
  env,
  parametersFrame,
  SelfType,
  ModuleType,
}: {
  parameters: FunctionParameter[];
  typeParameters: FunctionParameter[];
  implicitParameters: FunctionParameter[];
  return_: FunctionReturn;
  env: Environment;
  parametersFrame: Frame;
  SelfType?: Type;
  ModuleType?: ModuleType;
}): FunctionType {
  return {
    tag: TypeTag.Function,
    parameters: parameters, // Wrap params in a TupleType
    typeParameters,
    implicitParameters,
    return: return_,
    env,
    parametersFrame,
    SelfType,
    ModuleType,
  };
}

export function createMutPtrType(type: Type): MutPtrType {
  return {
    tag: TypeTag.MutPtr,
    type,
  };
}

export function createPtrType(type: Type): PtrType {
  return {
    tag: TypeTag.Ptr,
    type,
  };
}

export function createMutRefType(type: Type): MutRefType {
  return {
    tag: TypeTag.MutRef,
    type,
  };
}

export function createRefType(type: Type): RefType {
  return {
    tag: TypeTag.Ref,
    type,
  };
}

export function createTypeHierarchy(
  level: number,
  baseType?: Type
): TypeHierarchyType {
  return {
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
