# Third-Party Notices

FoxFetch includes or builds with the following direct third-party packages. The full dependency graph and license texts are available from the linked upstream projects and the installed package metadata.

| Package                | Version | License      | Project                                                                 |
| ---------------------- | ------: | ------------ | ----------------------------------------------------------------------- |
| WXT                    |  0.21.4 | MIT          | <https://github.com/wxt-dev/wxt>                                        |
| React / React DOM      |  19.2.8 | MIT          | <https://github.com/facebook/react>                                     |
| Zod                    |   4.5.4 | MIT          | <https://github.com/colinhacks/zod>                                     |
| idb                    |   8.0.3 | ISC          | <https://github.com/jakearchibald/idb>                                  |
| Mediabunny             |  1.55.4 | MPL-2.0      | <https://github.com/Vanilagy/mediabunny>                                |
| Mediabunny MP3 Encoder |  1.55.4 | MPL-2.0      | <https://github.com/Vanilagy/mediabunny/tree/main/packages/mp3-encoder> |
| MP4Box.js              |   2.4.1 | BSD-3-Clause | <https://github.com/gpac/mp4box.js>                                     |

Build and test dependencies are not executed as remote code by the extension. All JavaScript shipped in the extension package is bundled locally.

## SABR transport

`googlevideo` 4.1.1 (MIT, https://github.com/LuanRT/googlevideo) and its
`@bufbuild/protobuf` dependency are pinned by the lockfile. The full GitHub edition
bundles these locally for its YouTube transport; no remote player JavaScript is
evaluated. FoxFetch's local googlevideo changes are recorded in `patches/`.

Googlevideo copyright (c) 2024 LuanRT.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

`@mediabunny/mp3-encoder` embeds a WebAssembly build of LAME 3.100. LAME is licensed under the LGPL; source and license information are available from <https://lame.sourceforge.io/>. The encoder runs locally and does not load code from a CDN.

`@ffmpeg/core` and FFmpeg.wasm are intentionally not part of FoxFetch v1.0.0 Beta. Standard MP4 packet-copy and local MP3 encoding use the packages listed above; FFmpeg will not be distributed until licensing, memory, performance, and package-size impacts have been reviewed separately.

## Source availability for this release

The release provides `FoxFetch-v1.0.0-Beta-third-party-sources.zip` alongside the Chrome installation ZIP at https://github.com/IKITheFox/FoxFetch/releases/tag/v1.0.0-Beta . It includes the complete Mediabunny v1.55.4 upstream tree (core and MP3 encoder, MPL-2.0), the LAME 3.100 source distribution, and protobuf-es v2.14.1. See [third-party source and rebuild instructions](THIRD_PARTY_SOURCES.md). Covered third-party source retains its original licenses; FoxFetch copyright statements do not restrict those rights.

`@bufbuild/protobuf` 2.14.1 is licensed under Apache-2.0 AND BSD-3-Clause. Both texts are included in `third-party-licenses/`. LAME 3.100 source headers specify GNU Library GPL version 2 or later; its original COPYING is included as `LAME-LGPL-2.0-LICENSE`. FoxFetch uses the upstream MP3 encoder binary and has not modified LAME or the Mediabunny packages. The source archive and rebuild instructions support replacing those components. No restriction on reverse engineering for debugging modifications to LGPL-covered components is intended.

## FoxFetch GPL-3.0-only distribution

FoxFetch's own code is licensed under GPL-3.0-only; see LICENSE and COPYRIGHT.md.
The original third-party copyright notices and license texts remain in place.

The unmodified Mediabunny 1.55.4 and MP3 encoder sources use MPL-2.0 and do not
carry an Exhibit B incompatibility notice in their source headers. When combined
with FoxFetch as a GPLv3 larger work, those covered sources are also available
under GPLv3 as permitted by MPL-2.0 section 3.3; their MPL notices are retained.
The LAME source continues to carry its GNU Library GPL version 2-or-later
notice. The protobuf Apache-2.0 and BSD-3-Clause notices remain applicable.

Corresponding third-party sources and component replacement instructions are
available through THIRD_PARTY_SOURCES.md and the release's source attachments.
The project GPL grant does not replace third-party terms or remove obligations
to provide their covered source.
