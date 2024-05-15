infixr 20 ||  // Logical OR
infixr 30 &&  // Logical AND
infixl 60 |   // Bitwise OR
infixl 60 ^   // Bitwise XOR
infixl 70 &   // Bitwise AND

export type LogicalAnd<T: Type> = {
  (&&): (a: T, b: T)=> boolean;
}

export type LogicalOr<T: Type> = {
  (||): (a: T, b: T)=> boolean;
}

export type BitNot<T: Type> = {
  (~): (value: T)=> T;
}

export type LogicalNot<T: Type> = {
  (!): (value: T)=> boolean;
}

export type BitAnd<T: Type> = {
  (&): (a: T, b: T)=> T;
}

export type BitOr<T: Type> = {
  (|): (a: T, b: T)=> T;
}

export type BitXor<T: Type> = {
  (^): (a: T, b: T)=> T;
}