{ pkgs ? import <nixpkgs> { }, pkgsUnstable }:
with pkgs;
let
  gccForLibs = stdenv.cc.cc;
in
mkShell rec {
  buildInputs = [
    pkgs.bun
    # python3
    # cmake
    # llvmPackages_14.llvm
    clang
    mimalloc
    gdb
    valgrind
  ];
  LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath buildInputs;
  # where to find libgcc
  NIX_LDFLAGS="-L${gccForLibs}/lib/gcc/${targetPlatform.config}/${gccForLibs.version}";
  # teach clang about C startup file locations
  CFLAGS="-B${gccForLibs}/lib/gcc/${targetPlatform.config}/${gccForLibs.version} -B ${stdenv.cc.libc}/lib";

  cmakeFlags = [
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
  '';
}
