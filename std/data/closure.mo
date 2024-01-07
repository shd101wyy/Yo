export class Closure<
  ContextType: Linear, 
  ArgumentsType: Type,
  ReturnType: Type
  > {
  call: (context: ContextType, arguments: ArgumentsType)
        -> ReturnType;
}

export class ImmutableClosure<
  ContextType: Free, 
  ArgumentsType: Type,
  ReturnType: Type
  RegionType: Region
  > {
  call: (context: &<ContextType, RegionType>, arguments: ArgumentsType)
        -> ReturnType;
}

export class MutableClosure<
  ContextType: Free, 
  ArgumentsType: Type,
  ReturnType: Type
  RegionType: Region
  > {
  call: (context: &!<ContextType, RegionType>, arguments: ArgumentsType)
        -> ReturnType;
}
