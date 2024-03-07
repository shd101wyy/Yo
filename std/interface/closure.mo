export interface Closure<
  ContextType: Type,
  ArgumentsType: Type,
  ReturnType: Type
> {
  apply: (context: ContextType, 
          arguments: ArgumentsType)
        => ReturnType;
}
