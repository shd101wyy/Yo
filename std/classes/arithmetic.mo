/**
 * Define the operator precedence for the Mo language.  
 * 1 is the lowest precedence.  
 * Reference: https://rosettacode.org/wiki/Operator_precedence#Haskell
 */
infixl 60 +   // Addition
infixl 60 -   // Subtraction
infixl 70 *   // Multiplication
infixl 70 /   // Division
infixl 70 %   // Modulus
infixl 70 <<  // Bitwise left shift
infixl 70 >>  // Bitwise right shift
infixr 80 **  // Exponentiation. 3 ** 4 ** 6 == 3 ** (4 ** 6)


export trait Add<Rhs=Lhs> for Lhs: Type {
  Output: Type = Lhs;
  (+): (lhs: Lhs, rhs: Rhs)-> this.Output;
}

export trait Sub<Rhs=Lhs> for Lhs: Type {
  Output: Type = Lhs;
  (-): (lhs: Lhs, rhs: Rhs)-> this.Output;
}

export trait Mul<Rhs=Lhs> for Lhs: Type {
  Output: Type = Lhs;
  (*): (lhs: Lhs, rhs: Rhs)-> this.Output;
}

export trait Div<Rhs=Lhs> for Lhs: Type {
  Output: Type = Lhs;
  (/): (lhs: Lhs, rhs: Rhs)-> this.Output;
}

export trait Mod<Rhs=Lhs> for Lhs: Type {
  Output: Type = Lhs;
  (%): (lhs: Lhs, rhs: Rhs)-> this.Output;
}

export trait BitLeftShift<Rhs=Lhs> for Lhs: Type {
  Output: Type = Lhs;
  (<<): (lhs: Lhs, rhs: Rhs)-> this.Output;
}

export trait BitRightShift<Rhs=Lhs> for Lhs: Type {
  Output: Type = Lhs;
  (>>): (lhs: Lhs, rhs: Rhs)-> this.Output;
}

export trait Exponentiation<Rhs=Lhs> for Lhs: Type {
  Output: Type = Lhs;
  (**): (lhs: Lhs, rhs: Rhs)-> this.Output;
}

export trait Negate for Self: Type {
  Output: Type = Self;
  (-): (self: Self)-> this.Output;
}
