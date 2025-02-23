export class FnOnce<
  Context: Type,
  Arguments: Type,
> {
  Output: Type;
  call_once: (self: Context, arguments: Arguments)
                -> this.Output;
}

export trait FnMut<
  Context: Free with FnOnce<Arguments>,
  Arguments: Type
>
{
  call_mut: (self: &mut Context, arguments: Arguments)
              -> // this.Output; 
                FnOnce<Context, Arguments>.Output;
}

export trait Fn<
  Context: Free with FnMut<Arguments>,
  Arguments: Type
>
{
  call: (self: &Context, arguments: Arguments)
          -> // this.Output
            FnMut<Arguments>.Output;
}