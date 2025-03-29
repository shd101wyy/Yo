/**
 * There is no operator precedence in Mo
 */

fn Add(Lhs: Type, Rhs = Lhs), interface {
  (Output: Type) = Lhs,
  (+): (fn(lhs: Lhs, rhs: Rhs)-> this.Output)
}; 

fn Sub(Lhs: Type, Rhs = Lhs), interface {
  (Output: Type) = Lhs,
  (-): (fn(lhs: Lhs, rhs: Rhs)-> this.Output)
};

fn Mul(Lhs: Type, Rhs = Lhs), interface {
  (Output: Type) = Lhs,
  (*): (fn(lhs: Lhs, rhs: Rhs)-> this.Output)
};

fn Div(Lhs: Type, Rhs = Lhs), interface {
  (Output: Type) = Lhs,
  (/): (fn(lhs: Lhs, rhs: Rhs)-> this.Output)
};

fn Mod(Lhs: Type, Rhs = Lhs), interface {
  (Output: Type) = Lhs,
  (%): (fn(lhs: Lhs, rhs: Rhs)-> this.Output)
};

fn BitLeftShift(Lhs: Type, Rhs = Lhs), interface {
  (Output: Type) = Lhs,
  (<<): (fn(lhs: Lhs, rhs: Rhs)-> this.Output)
};

fn BitRightShift(Lhs: Type, Rhs = Lhs), interface {
  (Output: Type) = Lhs,
  (>>): (fn(lhs: Lhs, rhs: Rhs)-> this.Output)
};

fn Exponentiation(Lhs: Type, Rhs = Lhs), interface {
  (Output: Type) = Lhs,
  (**): (fn(lhs: Lhs, rhs: Rhs)-> this.Output)
};

fn Negate(Self: Type), interface {
  (Output: Type) = Self,
  (-): (fn(self: Self)-> this.Output)
};

{ 
  Add,
  Sub,
  Mul,
  Div,
  Mod,
  BitAnd,
  BitOr,
  BitXor,
  BitLeftShift,
  BitRightShift,
  Exponentiation,
  Negate
}