{
  pkgs ? import <nixpkgs> { },
}:
with pkgs;
let
  gccForLibs = stdenv.cc.cc;
in
mkShell rec {
  nativeBuildInputs = [ # build-time tools
    pkg-config
    # cmake
  ];
  buildInputs = [
    bash # Hack for running "copilot" CLI in the shell
         # https://github.com/github/copilot-cli/issues/1428
    # Node stays although the compiler no longer uses it: `emscripten` below is
    # itself a node program, and `vsce` packages the npm-only vscode-extension/.
    nodejs_24
    python3 # scripts/*.py + scripts/bootstrap/*.py instrumentation
    # llvmPackages_14.llvm
    clang
    gdb
    emscripten
    wasmtime
    vsce
    ripgrep
  ] ++ pkgs.lib.optionals pkgs.stdenv.isLinux [
    liburing
    valgrind
  ];
  LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath buildInputs;
  # where to find libgcc
  ## NIX_LDFLAGS="-L${gccForLibs}/lib/gcc/${targetPlatform.config}/${gccForLibs.version}";
  # teach clang about C startup file locations
  ## CFLAGS="-B${gccForLibs}/lib/gcc/${targetPlatform.config}/${gccForLibs.version} -B ${stdenv.cc.libc}/lib";

  cmakeFlags = pkgs.lib.optionals pkgs.stdenv.isLinux [
    "-DGCC_INSTALL_PREFIX=${gcc}"
    "-DC_INCLUDE_DIRS=${stdenv.cc.libc.dev}/include"
    "-GNinja"
    # Debug for debug builds
    "-DCMAKE_BUILD_TYPE=Release"
    # inst will be our installation prefix
    "-DCMAKE_INSTALL_PREFIX=../inst"
    "-DLLVM_INSTALL_TOOLCHAIN_ONLY=ON"
    # change this to enable the projects you need
    "-DLLVM_ENABLE_PROJECTS=clang"
    # enable libcxx* to come into play at runtimes
    "-DLLVM_ENABLE_RUNTIMES=libcxx;libcxxabi"
    # this makes llvm only to produce code for the current platform, this saves CPU time, change it to what you need
    "-DLLVM_TARGETS_TO_BUILD=host"
  ];

  LANG = "C.UTF-8";
  shellHook = with pkgs; ''
    ## unset TEMP TMP TEMPDIR TMPDIR
  '';
}
