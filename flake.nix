{
    description = "Recordings (dim-recordings), a dimOS Desktop app: `nix build .#dimosApp` → bin/dimos-app-server (Deno backend + built React frontend; ffmpeg for previews)";
    inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    # deno only: 25.05's deno (2.2) has no node:sqlite loadExtension (sqlite-vec needs it); 2.9 (unstable) refuses
    # extensions and file: URIs (the read-only immutable opens), 25.11's 2.6 does both
    inputs.nixpkgs-deno.url = "github:NixOS/nixpkgs/nixos-25.11";
    nixConfig = {
        extra-substituters = [ "https://dimos-desktop.cachix.org" ];
        extra-trusted-public-keys = [ "dimos-desktop.cachix.org-1:A4P35aGJGmCan92LWyamtSFXMqaVE+VRFYnrJ8QMTeQ=" ];
    };
    outputs = { self, nixpkgs, nixpkgs-deno }:
        let
            systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
            forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
            # the server: deno runs the bundled backend with the built page; ffmpeg (previews) comes first on PATH;
            # sqlite-vec (DIM_RECORDINGS_SQLITE_VEC, no suffix: SQLite adds .dylib / .so) lets stream edits touch a
            # stream's embedding index. --cached-only: the backend is one bundled file, nothing downloads at run time
            serverLine = target: backend: frontend:
                let deno = nixpkgs-deno.legacyPackages.${target.stdenv.hostPlatform.system}.deno; in
                "export PATH=${target.ffmpeg-headless}/bin:$PATH\nexport DIM_RECORDINGS_SQLITE_VEC=${target.sqlite-vec}/lib/vec0\nexec ${deno}/bin/deno run -A --no-lock --cached-only ${backend}/server.js --frontend ${frontend} \"$@\"";
            # bin/dimos-app-server for <arch> Linux, written on any machine: its bash, deno and ffmpeg are the target's (cache.nixos.org downloads, nothing built)
            linuxApp = pkgs: arch: backend: frontend:
                let linux = nixpkgs.legacyPackages."${arch}-linux"; in
                pkgs.writeTextFile {
                    name = "dimos-app-server-${arch}-linux";
                    destination = "/bin/dimos-app-server";
                    executable = true;
                    text = "#!${linux.runtimeShell}\n${serverLine linux backend frontend}\n";
                };
        in {
            packages = forAll (pkgs: rec {
                frontend = pkgs.buildNpmPackage {
                    pname = "dim-recordings-frontend";
                    version = "0.1.0";
                    src = ./frontend;
                    # `nix build .#frontend` prints the right hash when package-lock.json changes
                    npmDepsHash = "sha256-w80EzhlEKvWMcdibE5ckyqND3w4BnCqBXLepvu8TVKo=";
                    installPhase = "cp -r dist $out";
                };
                # backend/main.ts and its npm packages as one ES module (esbuild; backend/bundle), from package-lock.json
                backendBundle = pkgs.buildNpmPackage {
                    pname = "dim-recordings-backend";
                    version = "0.1.0";
                    src = ./backend;
                    sourceRoot = "backend/bundle";
                    # `nix build .#backendBundle` prints the right hash when backend/bundle/package-lock.json changes
                    npmDepsHash = "sha256-71QJP1uCi5p8/UbPABm6OKJAWhia8CW3FtbxH0jpAfg=";
                    installPhase = "mkdir -p $out && cp dist/server.js $out/server.js";
                };
                dimosApp = pkgs.writeTextFile {
                    name = "dim-recordings";
                    destination = "/bin/dimos-app-server";
                    executable = true;
                    text = "#!${pkgs.runtimeShell}\n${serverLine pkgs backendBundle frontend}\n";
                };
                default = dimosApp;
                # the sqlite-vec extension the server loads (CI points the tests at it too)
                sqliteVec = pkgs.sqlite-vec;
                # the frontend and the bundled backend are plain JS, so the same builds serve every target
                dimosApp-aarch64-linux = linuxApp pkgs "aarch64" backendBundle frontend;
                dimosApp-x86_64-linux = linuxApp pkgs "x86_64" backendBundle frontend;
            });
        };
}
