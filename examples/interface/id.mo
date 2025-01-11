export interface Id<T: Type> {
  id: (x: T)=> T;
}

implements Id<()> {
  id: (x: ()) => () {
    ()
  }
}
