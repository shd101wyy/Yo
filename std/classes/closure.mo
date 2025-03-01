export trait FnOnce<
  Context: Type,
  Arguments: Type,
> {
  Output: Type;
  call_once: (self: Context, arguments: Arguments)
                -> this.Output;
}

export trait FnMut<
  Context: Free with FnOnce<Arguments>;
  Arguments: Type;
>
{
  Output: Type = FnOnce<Arguments>.Output;
  call_mut: (self: &mut Context, arguments: Arguments)
              -> this.Output; 
}

export trait Fn<
  Context: Free with FnMut<Arguments>,
  Arguments: Type
>
{
  Output: Type = FnMut<Arguments>.Output;
  call: (self: &Context, arguments: Arguments)
          -> this.Output;
}