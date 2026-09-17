" Vim syntax file for Yo language
" Mirrors yo.tmLanguage.json — keep the two in sync.
" Place this file in ~/.vim/syntax/ or ~/.config/nvim/syntax/
"
" Keyword/builtin vocabulary mirrors the CURRENT language as implemented in
" src/lexer.yo, src/token.yo, src/parser.yo and src/evaluator/. Yo has no
" reserved keywords in the lexer (only `true`/`false` are special-cased);
" the groups below highlight names the evaluator or parser recognizes.

if exists("b:current_syntax")
  finish
endif

" Set keyword characters for Yo language
setlocal iskeyword=@,48-57,_,192-255

" Comments — doc forms first so they win at the same position.
" `///` is a doc comment, `////` is a plain comment; `/**` is a doc block,
" `/**/` is a plain comment. Block comments nest.
syn match yoInnerDocLine "//!.*" contains=yoTodo
syn match yoDocLineComment "///[^/].*" contains=yoTodo
syn match yoDocLineComment "///$" contains=yoTodo
syn match yoLineComment "//.*" contains=yoTodo
syn region yoDocBlockComment start="/\*\*[^/]" end="\*/" contains=yoTodo,yoDocBlockComment keepend
syn region yoInnerDocBlockComment start="/\*!" end="\*/" contains=yoTodo,yoInnerDocBlockComment keepend
syn region yoCommentBlock start="/\*" end="\*/" contains=yoTodo,yoCommentBlock keepend

syn match yoTodo /\<TODO\>/ contained

" Strings, chars, template strings
syn region yoString start=+"+ skip=+\\\\\|\\"+ end=+"+ contains=yoStringEscape
syn match yoStringEscape /\\./ contained
syn region yoChar start=+'+ skip=+\\\\\|\\'+ end=+'+ contains=yoStringEscape
syn region yoTemplateString start=+`+ skip=+\\`+ end=+`+ contains=yoStringEscape,yoTemplateInterp
syn region yoTemplateInterp start=+\${+ end=+}+ contained contains=yoTemplateBrace,yoStringEscape,@yoExpressions
syn region yoTemplateBrace start=+{+ end=+}+ contained contains=yoTemplateBrace,@yoExpressions
syn cluster yoExpressions contains=yoString,yoChar,yoTemplateString,yoNumber,yoNumberHex,yoNumberBin,yoNumberOct,yoOperator,yoKeyword,yoBuiltinFunction,yoAsync,yoSelf,yoTypeName,yoBuiltinType,yoBuiltinValues

" Numbers — one number is one token; underscores only in decimal digits.
" A Float needs `.digit` or an exponent (`1e5` is a Float); `1.foo` is
" `1` `.` `foo`.
syn match yoNumberHex /\v<0[xX][0-9a-fA-F]+>/
syn match yoNumberBin /\v<0[bB][01]+>/
syn match yoNumberOct /\v<0[oO][0-7]+>/
syn match yoNumber /\v<\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d[\d_]*)?>/

" Operators — Yo has a CLOSED operator set; a run of operator characters is
" split greedily against the table in src/lexer.yo (no `**` token, and `∀`
" is rejected outright).
syn match yoOperator /[-=+*\/<>@$~&%|!?^.:\\#]\+/

" Control-flow heads — ordinary calls the evaluator recognizes
syn keyword yoKeyword if cond match while for return unwind recur break continue

" Declarations and type constructors
syn keyword yoKeyword fn ctl unsafe_fn type struct union enum newtype trait impl ref atomic box dyn
syn keyword yoKeyword export import extern c_include test thread_local

" Parameter label modifiers, signature clauses, ghost/contract surface
syn keyword yoKeyword comptime generic where using given own inout quote
syn keyword yoKeyword forall exists ghost ghost_fn requires ensures invariant
syn keyword yoKeyword decreases refine assumed old

" Builtin functions and comptime surface
syn keyword yoBuiltinFunction sizeof alignof typeid typeof gensym consume dup drop rc the downcast
syn keyword yoBuiltinFunction derive derive_rule macro_expand comptime_assert comptime_expect_error
syn keyword yoBuiltinFunction comptime_fn comptime_print comptime_eval comptime_read_file
syn keyword yoBuiltinFunction comptime_json_parse comptime_toml_parse comptime_list
syn keyword yoBuiltinFunction quote unquote unquote_splicing and or runtime
syn keyword yoBuiltinFunction unsafe pragma asm global_asm va_start begin
syn match yoBuiltinFunction /\<_\>/

" Async — io.async / io.await are methods on Io, but the words read as keywords
syn keyword yoAsync async await

" Self
syn keyword yoSelf self

" Type-of-type and trait names
syn keyword yoTypeName Type Trait Self SelfTrait Fn Impl Future Io Send Dyn Acyclic Comptime Runtime Expr Iso Concrete

" Builtin scalar types plus common prelude type constructors
syn keyword yoBuiltinType unit usize isize u8 u16 u32 u64 i8 i16 i32 i64 f32 f64
syn keyword yoBuiltinType bool char str void comptime_int comptime_float comptime_str
syn keyword yoBuiltinType int uint long ulong short ushort longlong ulonglong longdouble
syn keyword yoBuiltinType Array RawSlice ComptimeList String Option Result Box Arc
syn keyword yoBuiltinType ArrayList HashMap HashSet Ordering Range RangeInclusive

" Boolean values — the lexer's only keywords
syn keyword yoBuiltinValues true false

" Links to highlights
hi def link yoCommentBlock Comment
hi def link yoLineComment Comment
hi def link yoDocLineComment Comment
hi def link yoInnerDocLine Comment
hi def link yoDocBlockComment Comment
hi def link yoInnerDocBlockComment Comment
hi def link yoTodo Todo
hi def link yoString String
hi def link yoChar Character
hi def link yoTemplateString String
hi def link yoTemplateInterp Identifier
hi def link yoTemplateBrace Identifier
hi def link yoStringEscape SpecialChar
hi def link yoNumber Number
hi def link yoNumberHex Number
hi def link yoNumberBin Number
hi def link yoNumberOct Number
hi def link yoOperator Operator
hi def link yoKeyword Keyword
hi def link yoBuiltinFunction Function
hi def link yoAsync Keyword
hi def link yoSelf Identifier
hi def link yoTypeName Type
hi def link yoBuiltinType Type
hi def link yoBuiltinValues Constant

let b:current_syntax = "yo"
