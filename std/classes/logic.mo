infixr 20 ||  // Logical OR
infixr 30 &&  // Logical AND
infixl 60 |   // Bitwise OR
infixl 60 ^   // Bitwise XOR
infixl 70 &   // Bitwise AND

export class LogicalAnd<T: Type> {
  (&&): (a: T, b: T)=> boolean;
}

export class LogicalOr<T: Type> {
  (||): (a: T, b: T)=> boolean;
}

export class BitNot<T: Type> {
  (~): (value: T)=> T;
}

export class LogicalNot<T: Type> {
  (!): (value: T)=> boolean;
}

export class BitAnd<Lhs, Rhs=Lhs> {
  Output: Type;
  (&): (a: Lhs, b: Rhs)=> Output;
}

export class BitOr<Lhs, Rhs=Lhs> {
  Output: Type;
  (|): (a: Lhs, b: Rhs)=> Output;
}

export class BitXor<Lhs, Rhs=Lhs> {
  Output: Type;
  (^): (a: Lhs, b: Rhs)=> Output;
}