import { Expr } from "./expr";
import { Type, TypeTag } from "./type-checker";

export type Value =
  | {
      tag: TypeTag.Free | TypeTag.Linear | TypeTag.Type;
      type: Type;
      value: Type;
    }
  | {
      tag:
        | TypeTag.U8
        | TypeTag.I8
        | TypeTag.U16
        | TypeTag.I16
        | TypeTag.U32
        | TypeTag.I32
        | TypeTag.U64
        | TypeTag.I64
        | TypeTag.F16
        | TypeTag.F32
        | TypeTag.F64;
      type: Type;
      value: number;
    }
  | {
      tag: TypeTag.Boolean;
      type: Type;
      value: boolean;
    }
  | {
      tag: TypeTag.Char;
      type: Type;
      value: string;
    }
  | {
      tag: TypeTag.Array;
      type: Type;
      value: Value[];
    }
  | {
      tag: TypeTag.Tuple;
      type: Type;
      value: Value[];
    }
  | {
      tag: TypeTag.Record;
      type: Type;
      value: Record<string, Value>;
    }
  | {
      tag: TypeTag.Struct;
      type: Type;
      value: Value;
    }
  | {
      tag: TypeTag.Enum;
      type: Type;
      value: Value;
    }
  | {
      tag: TypeTag.Union;
      type: Type;
      value: Record<string, Value>;
    }
  | {
      tag: TypeTag.Function;
      type: Type;
      frameLevel: number;
      body: Expr;
    };
/* | {
      tag: "Interface";
      type: Interface;
      implementations: Record<string, Value>;
    }
      */
