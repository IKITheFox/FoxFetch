# Third-party sources and rebuilding

For FoxFetch v1.0.0 Beta. Download the third-party source asset from [this release](https://github.com/IKITheFox/FoxFetch/releases/tag/v1.0.0-Beta). Its archives preserve upstream licenses and source notices.

- mediabunny-v1.55.4.zip: https://codeload.github.com/Vanilagy/mediabunny/zip/refs/tags/v1.55.4 . Includes core source, shared helpers, MP3 encoder C bridge, LAME glue, and upstream build scripts. MPL-2.0.
- lame-3.100.tar.gz: LAME 3.100, obtained from https://distfiles.macports.org/lame/lame-3.100.tar.gz (mirror of the SourceForge release). SHA256 ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e. Original source: https://sourceforge.net/projects/lame/files/lame/3.100/ . GNU Library GPL 2 or later as stated in source headers.
- protobuf-es-v2.14.1.zip: https://codeload.github.com/bufbuild/protobuf-es/zip/refs/tags/v2.14.1 . Apache-2.0 and BSD-3-Clause.

## Rebuild or replace the MP3 component

Extract the Mediabunny and LAME archives. Follow `mediabunny-1.55.4/packages/mp3-encoder/README.md`, section Building and development. It specifies Emscripten configuration for LAME, copying libmp3lame.a into the MP3 encoder build directory, compiling src/lame-bridge.c, and running npm run build at the Mediabunny root after npm install. The package includes its upstream prebuilt glue/WASM. FoxFetch used the registry packages pinned by pnpm-lock.yaml; this release does not claim a bit-for-bit reconstruction of upstream WASM or knowledge of its exact original Emscripten version.

For a modified component, build Mediabunny, pack the root and packages/mp3-encoder packages with npm pack, then in a separate FoxFetch checkout use pnpm add with the resulting local package tarball paths. Run pnpm build and load .output/chrome-mv3 as an unpacked extension. This replaces the bundled components without a signing key. Preserve the third-party notices when distributing modifications.

The exact registry source files for both MPL packages are included under registry-source/ in the source asset, with package metadata and license texts, so recipients also have the source distributed with the installed packages. The project applies only the googlevideo patch declared in pnpm-workspace.yaml; no local Mediabunny or LAME patch is applied.
