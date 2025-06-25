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
    // size: 0, // Types themselves don't have runtime size
    level: 0,
    baseType,
  };
}

export function createLinearType(baseType?: Type): TypeHierarchyType {
  return {
    tag: TypeTag.Linear,
    // size: 0, // Types themselves don't have runtime size
    level: 0,
    baseType,
  };
}

export function createTypeType(baseType?: Type): TypeHierarchyType {
  return {
    tag: TypeTag.Type,
    // size: 0, // Types themselves don't have runtime size
    level: 0,
    baseType,
  };
}

export function createComptIntType(): Type {
  return {
    tag: TypeTag.ComptInt,
    // size: 0, // Size of compt_int is not available at runtime
  };
}

export function createComptFloatType(): Type {
  return {
    tag: TypeTag.ComptFloat,
    // size: 0, // Size of compt_float is not available at runtime
  };
}

export function createComptStringType(): Type {
  return {
    tag: TypeTag.ComptString,
    // size: 0, // Size of compt_string is not available at runtime
  };
}

export function createExprListType(): Type {
  return {
    tag: TypeTag.ExprList,
    // size: 0, // Size of compt_list is not available at runtime
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
export function createCharType(): Type {
  return {
    tag: TypeTag.Char,
    // size: 4 * 8, // 4 bytes for unicode character
  };
}

export function createUsizeType(): Type {
  return {
    tag: TypeTag.Usize,
    // size: getPtrSize() * 8, // Size of usize is the size of a pointer
  };
}

export function createIsizeType(): Type {
  return {
    tag: TypeTag.Isize,
    // size: getPtrSize() * 8, // Size of isize is the size of a pointer
  };
}

export function createU8Type(): Type {
  return {
    tag: TypeTag.U8,
    // size: 1 * 8, // 1 byte for u8
  };
}

export function createI8Type(): Type {
  return {
    tag: TypeTag.I8,
    // size: 1 * 8, // 1 byte for i8
  };
}

export function createU16Type(): Type {
  return {
    tag: TypeTag.U16,
    // size: 2 * 8, // 2 bytes for u16
  };
}

export function createI16Type(): Type {
  return {
    tag: TypeTag.I16,
    // size: 2 * 8, // 2 bytes for i16
  };
}

export function createU32Type(): Type {
  return {
    tag: TypeTag.U32,
    // size: 4 * 8, // 4 bytes for u32
  };
}

export function createI32Type(): Type {
  return {
    tag: TypeTag.I32,
    // size: 4 * 8, // 4 bytes for i32
  };
}

export function createU64Type(): Type {
  return {
    tag: TypeTag.U64,
    // size: 8 * 8, // 8 bytes for u64
  };
}

export function createI64Type(): Type {
  return {
    tag: TypeTag.I64,
    // size: 8 * 8, // 8 bytes for i64
  };
}

export function createF32Type(): Type {
  return {
    tag: TypeTag.F32,
    // size: 4 * 8, // 4 bytes for f32
  };
}

export function createF64Type(): Type {
  return {
    tag: TypeTag.F64,
    // size: 8 * 8, // 8 bytes for f64
  };
}

export function createUnitType(): Type {
  return {
    tag: TypeTag.Unit,
    // size: 0, // Unit has no runtime size
  };
}

// Type constructor functions (need to be updated to include kind)
export function createArrayType(elementType: Type, length: Value): ArrayType {
  /*
  if (elementType.size === undefined) {
    throw new Error(
      `Cannot create array type of ${typeToString(elementType)}.
Element type size is undefined.`
    );
  }
    */

  return {
    tag: TypeTag.Array,
    // size: elementType.size * length,
    elementType,
    length,
  };
}

export function createTupleType(elements: TupleElement[]): TupleType {
  /* let totalSize: undefined | number = 0;
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i]!;
    if (element.type.size === undefined) {
      totalSize = undefined;
    } else if (typeof totalSize === "number") {
      totalSize += element.type.size;
    }
  }
  */

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
  /*
  let totalSize: undefined | number = 0;
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i]!;
    if (element.type.size === undefined) {
      totalSize = undefined;
    } else if (typeof totalSize === "number") {
      totalSize += element.type.size;
    }
  }
  */

  const module = createModuleType(env);

  const structType: StructType = {
    tag: TypeTag.Struct,
    // size: totalSize,
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
  /*
  let totalSize: undefined | number = 0;
  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i]!;
    let variantSize = 0;
    if (variant.elements) {
      for (let j = 0; j < variant.elements.length; j++) {
        const element = variant.elements[j]!;
        if (element.type.size === undefined) {
          totalSize = undefined;
        } else if (typeof totalSize === "number") {
          variantSize += element.type.size;
        }
      }
    }
    if (typeof totalSize === "number") {
      totalSize = Math.max(totalSize, variantSize);
    }
  }

  // Get the tagSize in bits
  const tagSize =
    typeof totalSize === "number" && totalSize > 0
      ? Math.ceil(Math.log2(variants.length)) * 8
      : 0;
  */

  const module = createModuleType(env);

  const enumType: EnumType = {
    tag: TypeTag.Enum,
    // size: typeof totalSize === "number" ? totalSize + tagSize : undefined,
    variants: [],
    module,
    env,
    // tagSize,
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
  /*
  let maxSize = 0;
  for (let i = 0; i < elements.length; i++) {
    const type = elements[i]!.type;
    if (type.size === undefined) {
      throw new Error(
        `Cannot create union type: type at index ${i} has undefined size`
      );
    }
    maxSize = Math.max(maxSize, type.size);
  }
  */

  const module: ModuleType = createModuleType(env);

  const unionType: UnionType = {
    tag: TypeTag.Union,
    // size: maxSize, // Changed from totalSize to maxSize as unions use the size of largest variant
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
    // size: getPtrSize() * 8,
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
    // size: getPtrSize() * 8,
    type,
  };
}

export function createPtrType(type: Type): PtrType {
  return {
    tag: TypeTag.Ptr,
    // size: getPtrSize() * 8,
    type,
  };
}

export function createMutRefType(type: Type): MutRefType {
  return {
    tag: TypeTag.MutRef,
    // size: getPtrSize() * 8,
    type,
  };
}

export function createRefType(type: Type): RefType {
  return {
    tag: TypeTag.Ref,
    // size: getPtrSize() * 8,
    type,
  };
}

export function createTypeHierarchy(
  level: number,
  baseType?: Type
): TypeHierarchyType {
  return {
    tag: TypeTag.Type,
    // size: 0,
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
