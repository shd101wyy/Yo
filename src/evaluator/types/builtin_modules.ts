export const BuiltinModules = {
  Add: `
  Add :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (+)    :  (fn(lhs: Self, rhs: Rhs)-> Output)
  ;
`,
};
