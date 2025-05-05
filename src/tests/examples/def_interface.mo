def MyAdd:
  (compt(Self): Type) -> compt(Type),
  interface
    my_add: ((x: Self, y: Self)-> Self)
;

// Export
{ MyAdd }