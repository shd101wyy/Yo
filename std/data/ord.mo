import {*} from "./builtins.mo";

infix  40 <   // Less than
infix  40 <=  // Less than or equal to
infix  40 >   // Greater than
infix  40 >=  // Greater than or equal to

export enum Ordering {
  Less,
  Equal,
  Greater
}

export interface Ord<T: Type> {
  compare: (a: T, b: T)-> Ordering;
  (<): (a: T, b: T)-> boolean;
  (>): (a: T, b: T)-> boolean;
  (<=): (a: T, b: T)-> boolean;
  (>=): (a: T, b: T)-> boolean;
  max: (a: T, b: T)-> T;
  min: (a: T, b: T)-> T;
}