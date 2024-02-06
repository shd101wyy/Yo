export class Drop<T: Type> {
  drop: (value: T)-> ();
}

export class Clone<T: Type> {
  clone: (value: read T)-> T;
}