infixr 20 ||  // Logical OR
infixr 30 &&  // Logical AND
infixl 60 |   // Bitwise OR
infixl 60 ^   // Bitwise XOR
infixl 70 &   // Bitwise AND

export interface LogicalAnd<T: Type> {
  (&&): (a: T, b: T) -> boolean;
}

export interface LogicalOr<T: Type> {
  (||): (a: T, b: T) -> boolean;
}

export interface BitNot<T: Type> {
  (~): (value: T) -> T;
}

export interface LogicalNot<T: Type> {
  (!): (value: T) -> boolean;
}

export interface BitAnd<T: Type> {
  (&): (a: T, b: T) -> T;
}

export interface BitOr<T: Type> {
  (|): (a: T, b: T) -> T;
}

export interface BitXor<T: Type> {
  (^): (a: T, b: T) -> T;
}