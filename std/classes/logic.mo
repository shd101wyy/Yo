infixr 20 ||  // Logical OR
infixr 30 &&  // Logical AND
infixl 60 |   // Bitwise OR
infixl 60 ^   // Bitwise XOR
infixl 70 &   // Bitwise AND

export trait LogicalAnd<Rhs=Lhs> for Lhs: Type {
  (&&): (lhs: Lhs, rhs: Rhs)-> boolean;
}

export trait LogicalOr<Rhs=Lhs> for Lhs: Type {
  (||): (lhs: Lhs, rhs: Rhs)-> boolean;
}

export trait BitNot for Self: Type {
  (~): (self: Self)-> Self;
}

export trait LogicalNot for Self: Type {
  (!): (self: Self)-> boolean;
}

export trait BitAnd<Rhs=Lhs> for Lhs: Type {
  Output: Type;
  (&): (lhs: Lhs, rhs: Rhs)-> this.Output;
}

export trait BitOr<Rhs=Lhs> for Lhs: Type {
  Output: Type;
  (|): (lhs: Lhs, rhs: Rhs)-> this.Output;
}

export trait BitXor<Rhs=Lhs> for Lhs: Type {
  Output: Type;
  (^): (lhs: Lhs, b: Rhs)-> this.Output;
}