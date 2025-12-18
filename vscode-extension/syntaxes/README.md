# Yo Vim syntax

This directory contains a minimal Vim/Neovim syntax file for the Yo language.

Files included
- `yo.vim` — Vim syntax script (place in your Vim runtime `syntax/` directory).

Installation

1) Copy the syntax file into your Vim/Neovim runtime:

For Vim:

```sh
mkdir -p ~/.vim/syntax
cp vscode-extension/syntaxes/yo.vim ~/.vim/syntax/
```

For Neovim:

```sh
mkdir -p ~/.config/nvim/syntax
cp vscode-extension/syntaxes/yo.vim ~/.config/nvim/syntax/
```

2) Enable filetype detection for `.yo` files. Create the ftdetect file `~/.vim/ftdetect/yo.vim` (or `~/.config/nvim/ftdetect/yo.vim`) with this content:

```vim
augroup yo_ft
  autocmd!
  autocmd BufRead,BufNewFile *.yo setfiletype yo
augroup END
```

3) Restart Vim/Neovim and open a `.yo` file. Verify:

```vim
:setfiletype?
:syntax list
```

Notes
- This is a conservative conversion of the existing TextMate grammar. It highlights comments, keywords, types, builtin functions, strings, chars, operators and basic numbers.
- If you prefer to keep the file under this repository and add it to Vim's runtimepath, you can symlink the file or add this repo to your `runtimepath`.

Troubleshooting
- If some keywords still don't appear highlighted:
  - Ensure the filetype is set to `yo`: open the file and run `:setfiletype?`.
  - Reload the buffer or restart Neovim so the syntax script is re-read: `:e` or restart the editor.
  - Run `:syntax list` to confirm `yo` groups are active and `:echo &filetype` to confirm the filetype.
  - If you use Tree-sitter or another highlighter, it may take precedence over Vim's syntax scripts. Temporarily disable Tree-sitter for `.yo` files or configure it to ignore this filetype.
