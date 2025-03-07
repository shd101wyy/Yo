export trait FnOnce<
  Context: Type,
  Arguments: Type
> {
  Output: Type;
  call_once: (self: Context, arguments: Arguments)
                -> this.Output;
}

export trait FnMut<
  Context: Free impl FnOnce<_, Arguments>, // _ here means Context
  Arguments: Type
>
{
  Output: Type = FnOnce<Context, Arguments>.Output;
  call_mut: (self: &mut Context, arguments: Arguments)
              -> this.Output; 
}

export trait Fn<
  Context: Free impl FnMut<_, Arguments>
  Arguments: Type
>
{
  Output: Type = FnMut<Context, Arguments>.Output;
  call: (self: &Context, arguments: Arguments)
          -> this.Output;
}