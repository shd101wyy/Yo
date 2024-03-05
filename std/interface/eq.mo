infix  40 ==  // Equality
infix  40 !=  // Inequality

export interface Eq<T: Type> {
  (==): (a: T, b: T)=> boolean;
  (!=): (a: T, b: T)=> boolean;
}