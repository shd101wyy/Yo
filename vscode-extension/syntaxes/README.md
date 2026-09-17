# Yo syntax files

This directory contains the editor syntax files for the Yo language.

Files included

- `yo.tmLanguage.json` — the TextMate grammar the VS Code extension loads.
- `yo.vim` — Vim syntax script mirroring the TextMate grammar (place in your
  Vim runtime `syntax/` directory).

Installation

1. Copy the syntax file into your Vim/Neovim runtime:

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

2. Enable filetype detection for `.yo` files. Create the ftdetect file `~/.vim/ftdetect/yo.vim` (or `~/.config/nvim/ftdetect/yo.vim`) with this content:

```vim
augroup yo_ft
  autocmd!
  autocmd BufRead,BufNewFile *.yo setfiletype yo
augroup END
```

3. Restart Vim/Neovim and open a `.yo` file. Verify:

```vim
:setfiletype?
:syntax list
```

Notes

- The Vim file mirrors `yo.tmLanguage.json`; update both together when the
  grammar changes. They highlight comments (including the `///` / `/**` doc
  forms), keywords, types, builtin functions, strings, chars, template
  strings and numbers (hex/binary/octal/decimal).
- If you prefer to keep the file under this repository and add it to Vim's runtimepath, you can symlink the file or add this repo to your `runtimepath`.

Troubleshooting

- If some keywords still don't appear highlighted:
  - Ensure the filetype is set to `yo`: open the file and run `:setfiletype?`.
  - Reload the buffer or restart Neovim so the syntax script is re-read: `:e` or restart the editor.
  - Run `:syntax list` to confirm `yo` groups are active and `:echo &filetype` to confirm the filetype.
  - If you use Tree-sitter or another highlighter, it may take precedence over Vim's syntax scripts. Temporarily disable Tree-sitter for `.yo` files or configure it to ignore this filetype.
