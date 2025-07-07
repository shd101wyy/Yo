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
    case TypeTag.Char: {
      return "char";
    }
    case TypeTag.Short: {
      return "short";
    }
    case TypeTag.UShort: {
      return "unsigned short";
    }
    case TypeTag.Int: {
      return "int";
    }
    case TypeTag.UInt: {
      return "unsigned int";
    }
    case TypeTag.Long: {
      return "long";
    }
    case TypeTag.ULong: {
      return "unsigned long";
    }
    case TypeTag.LongLong: {
      return "long long";
    }
    case TypeTag.ULongLong: {
      return "unsigned long long";
    }
    case TypeTag.LongDouble: {
      return "long double";
    }
  }

  throw new Error(`Unsupported type: ${type.tag}`);
}
