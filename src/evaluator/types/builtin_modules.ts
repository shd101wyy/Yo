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
  Mod: `
  Mod :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (%)    : (fn(lhs: Self, rhs: Rhs)-> Output)
  ;
`,

  BitLeftShift: `
  BitLeftShift :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (<<)   : (fn(lhs: Self, rhs: Rhs)-> Output)
  ;
`,

  BitRightShift: `
  BitRightShift :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (>>)   : (fn(lhs: Self, rhs: Rhs)-> Output)
  ;
`,

  Exponentiation: `
  Exponentiation :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (**)   : (fn(lhs: Self, rhs: Rhs)-> Output)
  ;
`,

  Negate: `
  Negate :: (fn(compt(Output) : Type)-> compt(Module)) 
    module
      Output := Output,
      (neg): (fn(self: Self)-> Output)
  ;
`,

  ComptNegate: `
  ComptNegate :: (fn(compt(Output) : Type)-> compt(Module)) 
    module
      Output := Output,
      (neg) : (fn(compt(self): Self)-> compt(Output))
  ;
`,
};
