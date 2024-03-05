export interface Closure<
  ContextType: Linear, 
  ArgumentsType: Type,
  ReturnType: Type
  > {
  call: (context: ContextType, arguments: ArgumentsType)
        => ReturnType;
}

export interface ImmutableClosure<
  ContextType: Free, 
  ArgumentsType: Type,
  ReturnType: Type
  RegionType: Region
  > {
  call: (context: &<ContextType, RegionType>, arguments: ArgumentsType)
        => ReturnType;
}

export interface MutableClosure<
  ContextType: Free, 
  ArgumentsType: Type,
  ReturnType: Type
  RegionType: Region
  > {
  call: (context: &!<ContextType, RegionType>, arguments: ArgumentsType)
        => ReturnType;
}
