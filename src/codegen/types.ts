import { Type, TypeTag } from "../types";

export function getTypeInC(type: Type): string {
  switch (type.tag) {
    case TypeTag.Unit: {
      return "void";
    }
    case TypeTag.Boolean: {
      return "bool";
    }
    case TypeTag.Usize: {
      return "size_t";
    }
    case TypeTag.Isize: {
      return "intptr_t";
    }
    case TypeTag.U8: {
      return "uint8_t";
    }
    case TypeTag.I8: {
      return "int8_t";
    }
    case TypeTag.U16: {
      return "uint16_t";
    }
    case TypeTag.I16: {
      return "int16_t";
    }
    case TypeTag.U32: {
      return "uint32_t";
    }
    case TypeTag.I32: {
      return "int32_t";
    }
    case TypeTag.U64: {
      return "uint64_t";
    }
    case TypeTag.I64: {
      return "int64_t";
    }
    case TypeTag.F32: {
      return "float";
    }
    case TypeTag.F64: {
      return "double";
    }
    case TypeTag.CChar: {
      return "char";
    }
    case TypeTag.CShort: {
      return "short";
    }
    case TypeTag.CUShort: {
      return "unsigned short";
    }
    case TypeTag.CInt: {
      return "int";
    }
    case TypeTag.CUInt: {
      return "unsigned int";
    }
    case TypeTag.CLong: {
      return "long";
    }
    case TypeTag.CULong: {
      return "unsigned long";
    }
    case TypeTag.CLongLong: {
      return "long long";
    }
    case TypeTag.CULongLong: {
      return "unsigned long long";
    }
    case TypeTag.CLongDouble: {
      return "long double";
    }
  }

  throw new Error(`Unsupported type: ${type.tag}`);
}
