infixr 20 ||  // Logical OR
infixr 30 &&  // Logical AND
infixl 60 |   // Bitwise OR
infixl 60 ^   // Bitwise XOR
infixl 70 &   // Bitwise AND

export trait LogicalAnd<Lhs: Type, Rhs=Lhs> {
  (&&): (lhs: Lhs, rhs: Rhs)-> boolean;
}

export trait LogicalOr<Lhs: Type, Rhs=Lhs> {
  (||): (lhs: Lhs, rhs: Rhs)-> boolean;
}

export trait BitNot<Self: Type> {
  (~): (self: Self)-> Self;
}

export trait LogicalNot<Self: Type> {
  (!): (self: Self)-> boolean;
}

export trait BitAnd<Lhs: Type, Rhs=Lhs> {
  Output: Type;
  (&): (lhs: Lhs, rhs: Rhs)-> this.Output;
}

export trait BitOr<Lhs: Type, Rhs=Lhs> {
  Output: Type;
  (|): (lhs: Lhs, rhs: Rhs)-> this.Output;
}

export trait BitXor<Lhs: Type, Rhs=Lhs> {
  Output: Type;
  (^): (lhs: Lhs, b: Rhs)-> this.Output;
}