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
            # frontendDeps' hash per system (see frontendDeps): aarch64-darwin and x86_64-darwin (Rosetta: `nix build
            # .#packages.x86_64-darwin.frontendDeps`) from a Mac, x86_64-linux and aarch64-linux from a Linux machine of that CPU
            frontendDepsHash = {
                aarch64-darwin = "sha256-LFEOkvwdDzZB7+X5YZOyhecy0Ni83wLAKZ51VQLB7gQ=";
                x86_64-darwin = "sha256-PJxSwQTazoSmXhNFxRo67T35bAa/kxfhxcZoUHV6xk8=";
                x86_64-linux = "sha256-KulE9j/kVj+3cu/RspFVZXaq0QYK5wcgSThTZbT2THc=";
                aarch64-linux = "";
            };
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
            packages = forAll (pkgs:
                let
                    deno = nixpkgs-deno.legacyPackages.${pkgs.stdenv.hostPlatform.system}.deno;
                    files = paths: pkgs.lib.fileset.toSource { root = ./.; fileset = pkgs.lib.fileset.unions paths; };
                    # DENO_DIR inside the build folder: deno bundle names its sources by their path from there
                    denoEnv = "export HOME=$TMPDIR DENO_DIR=$PWD/.deno DENO_NO_UPDATE_CHECK=1 DENO_NO_PROMPT=1 SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
                in rec {
                # frontend/deno.json's packages (`deno install --frozen`, deno.lock): npm ones in node_modules, dimos-react
                # (jsr) in vendor/. The only derivation with network, so fixed-output; per system, since npm's native
                # packages (rollup, esbuild) differ by OS and CPU. After changing frontend/deno.json or deno.lock: `deno task
                # update-hashes` refreshes this system's hash
                frontendDeps = pkgs.stdenvNoCC.mkDerivation {
                    name = "dim-recordings-frontend-deps";
                    src = files [ ./frontend/deno.json ./frontend/deno.lock ];
                    nativeBuildInputs = [ deno pkgs.cacert ];
                    buildPhase = ''
                        ${denoEnv}
                        cd frontend
                        deno install --frozen
                        # deno's own record of the install: not needed to build, and not byte-identical between installs
                        rm -f node_modules/.deno/.setup-cache.bin
                    '';
                    installPhase = "mkdir $out && cp -R node_modules vendor $out/";
                    dontFixup = true;
                    outputHashMode = "recursive";
                    outputHashAlgo = "sha256";
                    outputHash = frontendDepsHash.${pkgs.stdenv.hostPlatform.system};
                };
                # the page: vite against those packages, offline
                frontend = pkgs.stdenvNoCC.mkDerivation {
                    name = "dim-recordings-frontend";
                    src = files [ ./frontend ];
                    nativeBuildInputs = [ deno ];
                    buildPhase = ''
                        ${denoEnv}
                        cd frontend
                        cp -R ${frontendDeps}/node_modules ${frontendDeps}/vendor .
                        chmod -R u+w node_modules vendor
                        deno run -A --cached-only --node-modules-dir=manual npm:vite build
                    '';
                    installPhase = "cp -R dist $out";
                };
                # backend/main.ts and its npm packages as one ES module (deno bundle, deno.lock): the server downloads
                # nothing at run time. Fixed-output (it fetches the packages), the same file on every system;
                # `deno task update-hashes` refreshes it after backend/deps.ts or deno.lock change
                backendBundle = pkgs.stdenvNoCC.mkDerivation {
                    name = "dim-recordings-backend";
                    src = files [ ./deno.json ./deno.lock ./backend ];
                    nativeBuildInputs = [ deno pkgs.cacert ];
                    buildPhase = ''
                        ${denoEnv}
                        # dim-app's zenoh.js (vendored for checkTopic) lazily imports the browser's zenoh-gateway client; a backend never does
                        deno bundle --frozen --platform deno --external "node:*" --external ./vendor/zenoh-gateway/zenoh_gateway.js -o server.js backend/main.ts
                    '';
                    installPhase = "mkdir $out && cp server.js $out/server.js";
                    dontFixup = true;
                    outputHashMode = "recursive";
                    outputHashAlgo = "sha256";
                    outputHash = "sha256-oYxhjyXD+2QY6yPGJcIzbVswQ+n4TPzlyL+1UMgBI2U=";
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
