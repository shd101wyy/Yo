export const BuiltinModules = {
  Add: `
  Add :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (+)    :  (fn(lhs: Self, rhs: Rhs)-> Output)
  ;
`,
  Sub: `
  Sub :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (-)    : (fn(lhs: Self, rhs: Rhs)-> Output)
  ;
`,
  Mul: `
  Mul :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (*)    : (fn(lhs: Self, rhs: Rhs)-> Output)
  ;  
`,
  Div: `
  Div :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (/)    : (fn(lhs: Self, rhs: Rhs)-> Output)
  ;
`,
};
