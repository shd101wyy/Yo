export trait FnOnce<
  Arguments: Type,
> for Context: Type
{
  Output: Type;
  call_once: (self: Context, arguments: Arguments)
                -> Output;
}

export trait FnMut<
  Arguments: Type
> for Context: Free with FnOnce<Arguments>
{
  call_mut: (self: &mut Context, arguments: Arguments)
              -> FnOnce<Context, Arguments>.Output;
}

export trait Fn<
  Arguments: Type
> for Context: Free with FnMut<Arguments>
{
  call: (self: &Context, arguments: Arguments)
          -> FnMut<Arguments>.Output;
}