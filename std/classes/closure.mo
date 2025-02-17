export trait FnOnce<
  Context: Type,
  Arguments: Type,
>
{
  Output: Type;
  call_once: (self: Context, arguments: Arguments)
                -> this.Output;
}

export trait FnMut<
  Context: Free,
  Arguments: Type with FnOnce<Context, Arguments>,
>
{
  call_mut: (self: &mut Context, arguments: Arguments)
              -> FnOnce<Context, Arguments>.Output;
}

export trait Fn<
  Context: Free,
  Arguments: Type with FnMut<Context, Arguments>,
>
{
  call: (self: &Context, arguments: Arguments)
          -> FnMut<Context, Arguments>.Output;
}