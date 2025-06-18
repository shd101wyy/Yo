{
  description = "A very basic flake";

  inputs = {
    nixpkgs = {
      url = "github:NixOS/nixpkgs/nixos-25.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixpkgsUnstable = {
      url = "github:NixOS/nixpkgs/nixos-unstable";
      inputs.nixpkgsUnstable.follows = "nixpkgs";
    };
    flake-utils = {
      url = "github:numtide/flake-utils";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      nixpkgsUnstable,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        pkgsUnstable = import nixpkgsUnstable { inherit system; };
      in
      {
        devShell = import ./shell.nix {
          inherit pkgs;
          inherit pkgsUnstable;
        };
      }
    );
}
