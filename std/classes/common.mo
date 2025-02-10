export class Drop<T: Type> {
  drop: (value: T)=> ();
}

export class Clone<T: Type> {
  clone: (value: in T)=> T;
}

export class Copy<T: Type> {
  copy: (value: in T)=> T;
}