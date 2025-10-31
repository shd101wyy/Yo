export const BuiltinModules = {
  Add: `
  Add :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (+)    :  (fn(lhs: Self, rhs: Rhs)-> Output)
  ;
`,
  ComptAdd: `
  ComptAdd :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (+)    :  (fn(compt(lhs): Self, compt(rhs): Rhs)-> compt(Output))
  ; 
`,

  Sub: `
  Sub :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (-)    : (fn(lhs: Self, rhs: Rhs)-> Output)
  ;
`,

  ComptSub: `
  ComptSub :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (-)    : (fn(compt(lhs): Self, compt(rhs): Rhs)-> compt(Output))
  ;
  `,

  Mul: `
  Mul :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (*)    : (fn(lhs: Self, rhs: Rhs)-> Output)
  ;  
`,

  ComptMul: `
  ComptMul :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (*)    : (fn(compt(lhs): Self, compt(rhs): Rhs)-> compt(Output))
  ;
`,

  Div: `
  Div :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (/)    : (fn(lhs: Self, rhs: Rhs)-> Output)
  ;
`,
  ComptDiv: `
  ComptDiv :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (/)    : (fn(compt(lhs): Self, compt(rhs): Rhs)-> compt(Output))
  ;
  `,

  Mod: `
  Mod :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (%)    : (fn(lhs: Self, rhs: Rhs)-> Output)
  ;
`,
  ComptMod: `
  ComptMod :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (%)    : (fn(compt(lhs): Self, compt(rhs): Rhs)-> Output)
  ;
`,

  BitLeftShift: `
  BitLeftShift :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (<<)   : (fn(lhs: Self, rhs: Rhs)-> Output)
  ;
`,
  ComptBitLeftShift: `
  ComptBitLeftShift :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (<<)   : (fn(compt(lhs): Self, compt(rhs): Rhs)-> compt(Output))
  ;
  `,

  BitRightShift: `
  BitRightShift :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (>>)   : (fn(lhs: Self, rhs: Rhs)-> Output)
  ;
`,
  ComptBitRightShift: `
  ComptBitRightShift :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (>>)   : (fn(compt(lhs): Self, compt(rhs): Rhs)-> Output)
  ;
`,

  Exponentiation: `
  Exponentiation :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (**)   : (fn(lhs: Self, rhs: Rhs)-> Output)
  ;
`,
  ComptExponentiation: `
  ComptExponentiation :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
    module
      Output := Output,
      (**)   : (fn(compt(lhs): Self, compt(rhs): Rhs)-> compt(Output))
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
