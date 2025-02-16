infixr 20 ||  // Logical OR
infixr 30 &&  // Logical AND
infixl 60 |   // Bitwise OR
infixl 60 ^   // Bitwise XOR
infixl 70 &   // Bitwise AND

export trait LogicalAnd<Rhs = Self> {
  (&&): (self, rhs: Rhs)-> boolean;
}

export trait LogicalOr<Rhs = self> {
  (||): (self, rhs: Rhs)-> boolean;
}

export trait BitNot {
  (~): (self)-> Self;
}

export trait LogicalNot {
  (!): (self)-> boolean;
}

export trait BitAnd<Rhs=Self> {
  Output: Type;
  (&): (self, rhs: Rhs)-> Self.Output;
}

export trait BitOr<Rhs=Self> {
  Output: Type;
  (|): (self, rhs: Rhs)-> Self.Output;
}

export trait BitXor<Rhs=Self> {
  Output: Type;
  (^): (self, b: Rhs)-> Self.Output;
}