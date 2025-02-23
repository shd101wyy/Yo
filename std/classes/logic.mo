infixr 20 ||  // Logical OR
infixr 30 &&  // Logical AND
infixl 60 |   // Bitwise OR
infixl 60 ^   // Bitwise XOR
infixl 70 &   // Bitwise AND

export class LogicalAnd<Lhs: Type, Rhs=Lhs> {
  (&&): (lhs: Lhs, rhs: Rhs)-> boolean;
}

export class LogicalOr<Lhs: Type, Rhs=Lhs> {
  (||): (lhs: Lhs, rhs: Rhs)-> boolean;
}

export class BitNot<Self: Type> {
  (~): (self: Self)-> Self;
}

export class LogicalNot<Self: Type> {
  (!): (self: Self)-> boolean;
}

export class BitAnd<Lhs: Type, Rhs=Lhs> {
  Output: Type;
  (&): (lhs: Lhs, rhs: Rhs)-> this.Output;
}

export class BitOr<Lhs: Type, Rhs=Lhs> {
  Output: Type;
  (|): (lhs: Lhs, rhs: Rhs)-> this.Output;
}

export class BitXor<Lhs: Type, Rhs=Lhs> {
  Output: Type;
  (^): (lhs: Lhs, b: Rhs)-> this.Output;
}