fn LogicalAnd(Lhs: Type, Rhs = Lhs), interface {
  (&&): (fn(lhs: Lhs, rhs: Rhs)-> boolean)
};

fn LogicalOr(Lhs: Type, Rhs = Lhs), interface {
  (||): (fn(lhs: Lhs, rhs: Rhs)-> boolean)
};

fn LogicalNot(Self: Type), interface {
  (!): (fn(self: Self)-> boolean)
};

fn BitNot(Self: Type), interface {
  (~): (fn(self: Self)-> Self)
};

fn BitAnd(Lhs: Type, Rhs = Lhs), interface {
  (Output: Type) = Lhs,
  (&): (fn(lhs: Lhs, rhs: Rhs)-> this.Output)
};

fn BitOr(Lhs: Type, Rhs = Lhs), interface {
  (Output: Type) = Lhs,
  (|): (fn(lhs: Lhs, rhs: Rhs)-> this.Output)
};

fn BitXor(Lhs: Type, Rhs = Lhs), interface {
  (Output: Type) = Lhs,
  (^): (fn(lhs: Lhs, rhs: Rhs)-> this.Output)
};

{ 
  LogicalAnd,
  LogicalOr,
  LogicalNot,
  BitNot,
  BitAnd,
  BitOr,
  BitXor
}