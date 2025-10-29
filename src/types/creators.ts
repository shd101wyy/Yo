import { Environment, Frame } from "../env";
import { Expr, ExprTag } from "../expr";
import { PlaceholderToken } from "../token";
import { hashString, randomId } from "../utils";
import { createTypeValue, Value, valueToString } from "../value";
import {
  ArrayType,
  ClosureType,
  DynType,
  EnumType,
  FunctionForallParameter,
  FunctionImplicitParameter,
  FunctionParameter,
  FunctionParameterExprs,
  FunctionReturn,
  FunctionType,
  FutureType,
  ModuleElement,
  ModuleType,
  MutPtrType,
  SliceType,
  SomeType,
  StructType,
  TupleElement,
  TupleType,
  Type,
  TypeHierarchyType,
  UnionType,
  VoidType,
} from "./definitions";
import { TypeTag } from "./tags";

/**
 * Singleton primitive types
 */
export const PrimitiveTypes: Record<
  | TypeTag.ComptInt
  | TypeTag.ComptFloat
  | TypeTag.ComptString
  | TypeTag.ExprList
  | TypeTag.Expr
  | TypeTag.Boolean
  | TypeTag.Usize
  | TypeTag.Isize
  | TypeTag.U8
  | TypeTag.I8
  | TypeTag.U16
  | TypeTag.I16
  | TypeTag.U32
  | TypeTag.I32
  | TypeTag.U64
  | TypeTag.I64
  | TypeTag.F32
  | TypeTag.F64
  | TypeTag.Unit
  | TypeTag.Char
  | TypeTag.Short
  | TypeTag.UShort
  | TypeTag.Int
  | TypeTag.UInt
  | TypeTag.Long
  | TypeTag.ULong
  | TypeTag.LongLong
  | TypeTag.ULongLong
  | TypeTag.LongDouble,
  Type
> = {
  [TypeTag.ComptInt]: {
    id: TypeTag.ComptInt,
    tag: TypeTag.ComptInt,
  },
  [TypeTag.ComptFloat]: {
    id: TypeTag.ComptFloat,
    tag: TypeTag.ComptFloat,
  },
  [TypeTag.ComptString]: {
    id: TypeTag.ComptString,
    tag: TypeTag.ComptString,
  },
  [TypeTag.ExprList]: {
    id: TypeTag.ExprList,
    tag: TypeTag.ExprList,
  },
  [TypeTag.Expr]: {
    id: TypeTag.Expr,
    tag: TypeTag.Expr,
  },
  [TypeTag.Boolean]: {
    id: TypeTag.Boolean,
    tag: TypeTag.Boolean,
  },
  [TypeTag.Usize]: {
    id: TypeTag.Usize,
    tag: TypeTag.Usize,
  },
  [TypeTag.Isize]: {
    id: TypeTag.Isize,
    tag: TypeTag.Isize,
  },
  [TypeTag.U8]: {
    id: TypeTag.U8,
    tag: TypeTag.U8,
  },
  [TypeTag.I8]: {
    id: TypeTag.I8,
    tag: TypeTag.I8,
  },
  [TypeTag.U16]: {
    id: TypeTag.U16,
    tag: TypeTag.U16,
  },
  [TypeTag.I16]: {
    id: TypeTag.I16,
    tag: TypeTag.I16,
  },
  [TypeTag.U32]: {
    id: TypeTag.U32,
    tag: TypeTag.U32,
  },
  [TypeTag.I32]: {
    id: TypeTag.I32,
    tag: TypeTag.I32,
  },
  [TypeTag.U64]: {
    id: TypeTag.U64,
    tag: TypeTag.U64,
  },
  [TypeTag.I64]: {
    id: TypeTag.I64,
    tag: TypeTag.I64,
  },
  [TypeTag.F32]: {
    id: TypeTag.F32,
    tag: TypeTag.F32,
  },
  [TypeTag.F64]: {
    id: TypeTag.F64,
    tag: TypeTag.F64,
  },
  [TypeTag.Unit]: {
    id: TypeTag.Unit,
    tag: TypeTag.Unit,
  },
  [TypeTag.Char]: {
    id: TypeTag.Char,
    tag: TypeTag.Char,
  },
  [TypeTag.Short]: {
    id: TypeTag.Short,
    tag: TypeTag.Short,
  },
  [TypeTag.UShort]: {
    id: TypeTag.UShort,
    tag: TypeTag.UShort,
  },
  [TypeTag.Int]: {
    id: TypeTag.Int,
    tag: TypeTag.Int,
  },
  [TypeTag.UInt]: {
    id: TypeTag.UInt,
    tag: TypeTag.UInt,
  },
  [TypeTag.Long]: {
    id: TypeTag.Long,
    tag: TypeTag.Long,
  },
  [TypeTag.ULong]: {
    id: TypeTag.ULong,
    tag: TypeTag.ULong,
  },
  [TypeTag.LongLong]: {
    id: TypeTag.LongLong,
    tag: TypeTag.LongLong,
  },
  [TypeTag.ULongLong]: {
    id: TypeTag.ULongLong,
    tag: TypeTag.ULongLong,
  },
  [TypeTag.LongDouble]: {
    id: TypeTag.LongDouble,
    tag: TypeTag.LongDouble,
  },
};

export function createType0(baseType?: Type): TypeHierarchyType {
  return {
    id: "Type(0)",
    tag: TypeTag.Type,
    level: 0,
    baseType,
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

export function createVoidType(): VoidType {
  return {
    id: TypeTag.Void,
    tag: TypeTag.Void,
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

export function createStructType(
  env: Environment,
  isReferenceSemantics: boolean = false
): StructType {
  const module = createModuleType(env);

  const structType: StructType = {
    id: `struct_${randomId()}`,
    tag: TypeTag.Struct,
    isReferenceSemantics,
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
  forallParameters,
  implicitParameters,
  variadicParameter,
  return_,
  env,
  parametersFrame,
  SelfType,
  ModuleType,
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
  ModuleType?: ModuleType;
  isClosure?: boolean;
}): FunctionType {
  return {
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
    ModuleType,
    isClosure: isClosure ?? false,
  };
}

export function createMutPtrType(type: Type): MutPtrType {
  return {
    id: TypeTag.MutPtr,
    tag: TypeTag.MutPtr,
    type,
  };
}

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

  return {
    id: id ?? `sometype_${randomId()}`,
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

  // Add "Self" to closure type module, similar to struct type
  const typeValue = createTypeValue(closureType);
  const selfElement: ModuleElement = {
    type: typeValue.type,
    label: "Self",
    isCompileTimeOnly: true,
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

  // Add "Self" to dyn type module if not already present
  const typeValue = createTypeValue(dynType);
  const selfElement: ModuleElement = {
    type: typeValue.type,
    label: "Self",
    isCompileTimeOnly: true,
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

  // Add "Self" to future type module, similar to other ARC types
  const typeValue = createTypeValue(futureType);
  const selfElement: ModuleElement = {
    type: typeValue.type,
    assignedValue: typeValue,
    label: "Self",
    isCompileTimeOnly: true,
    exprs: {
      expr: {
        tag: ExprTag.Atom,
        token: PlaceholderToken,
      },
      labelExpr: {
        tag: ExprTag.Atom,
        token: PlaceholderToken,
      },
      typeExpr: undefined,
      defaultValueExpr: undefined,
      assignedValueExpr: {
        tag: ExprTag.Atom,
        token: PlaceholderToken,
      },
    },
  };
  futureType.module.elements.push(selfElement);

  return futureType;
}
