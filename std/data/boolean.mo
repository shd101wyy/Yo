infixr 20 ||  // Logical OR
infixr 30 &&  // Logical AND
infixl 60 |   // Bitwise OR
infixl 60 ^   // Bitwise XOR
infixl 70 &   // Bitwise AND

export class LogicalAnd<T: Type> {
  (&&): (a: T, b: T) -> boolean;
}

export class LogicalOr<T: Type> {
  (||): (a: T, b: T) -> boolean;
}

export class BitNot<T: Type> {
  (~): (value: T) -> T;
}

export class LogicalNot<T: Type> {
  (!): (value: T) -> boolean;
}

export class BitAnd<T: Type> {
  (&): (a: T, b: T) -> T;
}

export class BitOr<T: Type> {
  (|): (a: T, b: T) -> T;
}

export class BitXor<T: Type> {
  (^): (a: T, b: T) -> T;
}