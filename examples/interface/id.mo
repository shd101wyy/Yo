export interface Id<T: Type> {
  id: (x: T)-> T;
}