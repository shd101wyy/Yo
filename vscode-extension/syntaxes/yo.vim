" Vim syntax file for Yo language
" Converted from yo.tmLanguage.json
" Place this file in ~/.vim/syntax/ or ~/.config/nvim/syntax/

if exists("b:current_syntax")
  finish
endif

" Set keyword characters for Yo language
setlocal iskeyword=@,48-57,_,192-255

" Comments
syn region yoCommentBlock start="/\*" end="\*/" contains=yoTodo keepend
syn match yoLineComment "//.*$"

syn match yoTodo /\<TODO\>/ contained

" Strings and escapes
syn region yoString start=+"+ skip=+\\\\\|\\"+ end=+"+ contains=yoStringEscape
syn match yoStringEscape /\\./ contained
syn region yoChar start=+'+ skip=+\\\\\|\\'+ end=+'+ contains=yoStringEscape

" Numbers
syn match yoNumber /\v\<\d+(\.\d+)?([eE][+-]?\d+)?\>/

" Operators
syn match yoOperator /[-=+*\/<>@$~&%|!?^.:#∀]\+/

" Keywords
syn keyword yoKeyword let var while for select generic mut const in out inout ref break continue pass return unwind pure recur use borrow comptime runt resume shift reset panic assert test thread_local atomic
syn keyword yoKeyword open import export from as extern trait c_include exists where
syn keyword yoKeyword type fn ctl macro enum struct newtype union object actor impl dyn box chan static
syn keyword yoKeyword if cond then else switch case default match try with
syn keyword yoKeyword sizeof alignof typeof gensym consume take drop clone dup quote unquote unquote_splicing comptime_expect_error comptime_assert downcast array tuple comptime_list begin and or not the macro_expand runtime asm global_asm pragma
syn keyword yoKeyword async await spawn infix infixl infixr

" Type declarations and kinds  
syn keyword yoTypeName Type Trait Self SelfTrait This Dyn Impl Future Concrete Fn FnOnce Io Send Acyclic Comptime Runtime Copy Box Promise Array Slice Tuple Expr ComptimeList ExprList Iso Arc Result Impt unit

" Permissions and self-reference
syn keyword yoPermission read write own move copy control
syn keyword yoSelf self this

" Flow control and clauses
syn keyword yoDefer defer escapedefer

" Special identifier (underscore)
syn keyword yoSpecial _

" Infix precedence / identifiers
syn keyword yoInfixPrecedence infix infixl infixr
syn region yoInfixIdentifier start=+`+ skip=+\\\\\|\\`+ end=+`+ contains=yoStringEscape

" Types and values
syn keyword yoBuiltinTypes unit usize isize u8 i8 u16 i16 u32 i32 u64 i64 f16 f32 f64 boolean char symbol any voidptr void comptime_int comptime_float comptime_string anyopaque short ushort int uint long ulong longlong ulonglong longdouble
syn keyword yoBuiltinValues true false null undefined

" Links to highlights
hi def link yoCommentBlock Comment
hi def link yoLineComment Comment
hi def link yoTodo Todo
hi def link yoString String
hi def link yoChar Character
hi def link yoNumber Number
hi def link yoOperator Operator
hi def link yoKeyword Keyword
hi def link yoTypeDecl StorageType
hi def link yoTypeName Type
hi def link yoPermission Keyword
hi def link yoSelfName Type
hi def link yoPermission Keyword
hi def link yoSelf Identifier
hi def link yoDefer Keyword
hi def link yoSpecial SpecialType
hi def link yoBuiltinValues Constant

let b:current_syntax = "yo"
