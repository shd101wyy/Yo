infixr 20 ||  // Logical OR
infixr 30 &&  // Logical AND
infixl 60 |   // Bitwise OR
infixl 60 ^   // Bitwise XOR
infixl 70 &   // Bitwise AND

export trait LogicalAnd<Rhs=Self> {
  (&&): (lhs: Self, rhs: Rhs)-> boolean;
}

export trait LogicalOr<Rhs=Self> {
  (||): (lhs: Self, rhs: Rhs)-> boolean;
}

export trait BitNot {
  (~): (self: Self)-> Self;
}

export trait LogicalNot {
  (!): (self: Self)-> boolean;
}

export trait BitAnd<Rhs=Self> {
  Output: Type;
  (&): (lhs: Self, rhs: Rhs)-> this.Output;
}

export trait BitOr<Rhs=Self> {
  Output: Type;
  (|): (lhs: Self, rhs: Rhs)-> this.Output;
}

export trait BitXor<Rhs=Self> {
  Output: Type;
  (^): (lhs: Self, b: Rhs)-> this.Output;
}