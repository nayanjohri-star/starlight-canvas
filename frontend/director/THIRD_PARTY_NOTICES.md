# Third-Party Notices

CozyClay is an independent project. The names and licenses below apply only to their respective third-party projects and do not imply sponsorship, affiliation, or endorsement.

This Starlight release also includes `public/licenses/DEPENDENCY-MANIFEST.json`
and `DEPENDENCY-NOTICES.txt`, bound to both front-end lockfiles and containing
the installed dependencies' complete license/notice files. OS-specific optional
packages absent from this build are identified separately. Reviewed official
license copies for publishers that omit a license file retain their pinned
source URLs in `LICENSES/dependency-fallbacks.json`. `stats-gl` and
`@tybys/wasm-util` publish an MIT SPDX declaration but no license file; their
publisher attribution and standard MIT terms are included with that limitation
explicitly identified. No copyright holder is invented for those packages.

`public/licenses/BUNDLED-NOTICES.txt` and `BUNDLED-MANIFEST.json` also retain
the independent licenses and pinned attribution for the three font-parser
components embedded inside Troika 0.52.5: Typr.ts (MIT, Copyright 2016
Photopea), Unicode Font Resolver client 1.0.2 (MIT, Copyright 2023 Jason
Johnston), and woff2otf (Apache-2.0, Copyright 2012 Steffen Hanikel; modified
by Artemy Tregubenko in 2014). The full Apache and MIT texts, original notices,
factory hashes, official Git blobs and limits on upstream revision evidence
are preserved in `LICENSES/bundled/`. The embedded fflate component retains
its separate MIT notice in the dependency collection.
Starlight's Vite transform (`tools/local-font-resolver.mjs`) modifies the
Unicode Font Resolver factory to remove its public-CDN retry on local data
failure. Original copyright and license headers remain intact; failed local
resources produce a local error rather than sending document text elsewhere.

## Three.js

CozyClay's browser-based 3D studio uses [Three.js](https://threejs.org/) through `three`, `@react-three/fiber`, and `@react-three/drei`.

- Copyright (c) 2010-2026 three.js authors
- License: MIT
- Source: https://github.com/mrdoob/three.js
- License text: https://github.com/mrdoob/three.js/blob/dev/LICENSE

## Mediabunny

CozyClay uses [Mediabunny](https://mediabunny.dev/) to mux recorded WebCodecs
video frames into MP4 files in the browser.

- Copyright (c) 2024-2026 Vanilagy
- License: MPL-2.0
- Source: https://github.com/Vanilagy/mediabunny
- License text: https://github.com/Vanilagy/mediabunny/blob/main/LICENSE

## NVIDIA ARDY

CozyClay provides an optional bridge and data-conversion workflow for externally installed [ARDY](https://github.com/nv-tlabs/ardy), an interactive human-motion generation project from NVIDIA Research.

ARDY is not bundled with CozyClay. Users must obtain, install, and operate ARDY separately under NVIDIA's terms.

- Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES
- ARDY source license: Apache License 2.0
- Source: https://github.com/nv-tlabs/ardy
- Source license: https://github.com/nv-tlabs/ardy/blob/main/LICENSE

ARDY model checkpoints and other model assets may be governed by separate terms, including the NVIDIA Open Model License identified by the ARDY project. Users are responsible for reviewing and complying with those terms before downloading or using the models.

## NVIDIA Kimodo

CozyClay provides an optional bridge and data-conversion workflow for externally installed [Kimodo](https://github.com/nv-tlabs/kimodo), a human-motion generation project from NVIDIA Research, and [kimodo.cpp](https://github.com/localai-org/kimodo.cpp).

Kimodo runtimes and model weights are not bundled with CozyClay. Users must obtain, install, and operate them separately under NVIDIA's terms and the applicable runtime licenses.

- Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES (Kimodo skeleton data)
- Kimodo source license: Apache License 2.0
- Source: https://github.com/nv-tlabs/kimodo
- Source license: https://github.com/nv-tlabs/kimodo/blob/main/LICENSE
- kimodo.cpp source license: Apache License 2.0
- Source: https://github.com/localai-org/kimodo.cpp
- Source license: https://github.com/localai-org/kimodo.cpp/blob/main/LICENSE

`tools/kimodo/local-output.mjs` embeds skeleton constants extracted from the `nv-tlabs/kimodo` SOMA77 definitions and `kimodo/assets/skeletons/somaskel77/` assets at commit `1aece8c124d73d255ceff5086d983b844c9f4e94`: the joint hierarchy, neutral-pose offsets, and relaxed-hand rotation matrices. The source assets are pinned by SHA256:

- `joints.p`: `dc5fd8e39e0ff312f5d0f536a87ac22ac58445e13443fcb8ab54e6817cb97ce7`
- `relaxed_hands_rest_pose.npy`: `64a3828e0d1ef1f1de8228c74eba8040c0810d898169f1892d8997a213b2b64c`

Kimodo model checkpoints and other model assets may be governed by separate terms, including the NVIDIA Open Model License identified by the Kimodo project. Users are responsible for reviewing and complying with those terms before downloading or using the models.

## Meta Llama 3

ARDY's text encoder is based on Meta Llama 3 (`Meta-Llama-3-8B-Instruct`).
CozyClay does not bundle or redistribute the model weights; the optional
`tools/ardy/setup-text-encoder.py` script downloads them directly from a
public repository to the user's own machine for local use, together with the
model's LICENSE and USE_POLICY files.

Built with Meta Llama 3.

- Copyright © Meta Platforms, Inc. All Rights Reserved.
- License: Meta Llama 3 Community License
- License text: https://www.llama.com/llama3/license/
- Acceptable Use Policy: https://www.llama.com/llama3/use-policy/

Meta Llama 3 is licensed under the Meta Llama 3 Community License,
Copyright © Meta Platforms, Inc. All Rights Reserved.

## LLM2Vec

ARDY's text encoder applies the LLM2Vec adapters from McGill NLP
(`LLM2Vec-Meta-Llama-3-8B-Instruct-mntp` and `-mntp-supervised`). Like the
base weights, they are downloaded by the setup script for local use, not
bundled.

- Copyright (c) 2024 McGill NLP
- License: MIT (the adapters are derived from Meta Llama 3; the Meta Llama 3
  Community License applies to that underlying model)
- Source: https://github.com/McGill-NLP/llm2vec
- License text: https://github.com/McGill-NLP/llm2vec/blob/main/LICENSE

## Fonts

CozyClay bundles subsets of two typefaces. Both are licensed under the SIL Open
Font License 1.1, which allows them to be redistributed with software as long as
the copyright notice and the licence travel with the files. The licence texts are
in `public/fonts/` next to the fonts themselves.

### Inter

- Copyright (c) 2016 The Inter Project Authors
- License: SIL Open Font License 1.1
- Source: https://github.com/rsms/inter
- License text: `public/fonts/Inter-OFL.txt`

### Instrument Serif

- Copyright 2022 The Instrument Serif Project Authors
- License: SIL Open Font License 1.1
- Source: https://github.com/Instrument/instrument-serif
- License text: `public/fonts/InstrumentSerif-OFL.txt`

### Noto Sans SC — local 3D text

- Copyright © 2014-2021 Adobe, with Reserved Font Name "Source" (preserved in the font metadata).
- License: SIL Open Font License 1.1; `public/fonts/NotoSansSC-OFL.txt`.
- Official source: https://github.com/notofonts/noto-cjk — reviewed font Git blob `5371a543be5fc670c7cdee9760c03554ee3e9b8e`.
- `LICENSES/NotoSansSC-source.json` records the original and WOFF hashes, fixed weight 400, conversion and the 30,890 covered codepoints. The font retains its Noto family name.
- `tools/build-unicode-fonts.mjs` copies that licensed WOFF and generates Troika's complete local fallback index graph. Unsupported glyphs use this font's missing-glyph box; document text is preserved and the resolver never needs its public CDN.

## Character models and recorded test assets — Starlight modification

This fork does not distribute the upstream Adobe Mixamo raw models
`x-bot-tpose.fbx` or `y-bot-tpose.fbx`. The hosted renderer uses the original
procedural skin and rest document in `src/procedural-rig.js`; that code and its
generated geometry are part of this AGPL-3.0-or-later modification, not CC0.
No Adobe model is relicensed by this change.

Four unused upstream recorded test fixtures are excluded from this fork's
repository and corresponding source package because source-material rights
were not established: `boxing-offline-mixamo.bvh`, `shadow17-mixamo.bvh`,
`qa-lying.npz` and `heading-orient.json`. The names alone do not establish that
they are Adobe downloads. Current action/import tests generate original data,
including BVH and FBX, instead of redistributing those recordings.

## posthog-js

The hosted site at cozyclay.org uses [posthog-js](https://posthog.com/docs/libraries/js) for anonymous usage analytics.

The disclosed wire events include session start/end (bucketed duration and
actions), one-per-session feature usage, project save/open buckets, and the
hosted composer/login/ticket/result funnel. Events carry only the registered
`origin_kind`, coarse `os`, and npm `install_kind`; prompts, filenames, paths,
project names, and timestamps are excluded. Source checkouts keep telemetry
disabled. This hosted modification never initializes upstream analytics.
See the Analytics & privacy section in `README-UPSTREAM.md` for the upstream
event table and opt-out controls.

- Copyright PostHog Inc.
- License: Apache-2.0 AND MIT
- Source: https://github.com/PostHog/posthog-js

## pi agent packages

The upstream optional agent sidecar loads `@earendil-works/pi-ai` and
`@earendil-works/pi-agent-core` at runtime (they are declared dependencies,
loaded lazily by the sidecar; the launcher itself does not import them).
This browser-only modification excludes the sidecar launcher and removes
these packages from its locked dependencies. The following notices are
retained as upstream provenance, not a list of installed hosted services.

- Copyright (c) Earendil Works
- License: MIT
- Source: https://github.com/earendil-works/pi (packages/ai → @earendil-works/pi-ai, packages/agent → @earendil-works/pi-agent-core)

Their transitive runtime dependencies, which the agent sidecar also loads, are:

- `@anthropic-ai/sdk` — License: MIT — https://github.com/anthropics/anthropic-sdk-typescript
- `openai` — License: Apache-2.0 — https://github.com/openai/openai-node
- `@google/genai` — License: Apache-2.0 — https://github.com/googleapis/js-genai
- `@aws-sdk/client-bedrock-runtime` — License: Apache-2.0 — https://github.com/aws/aws-sdk-js-v3
- `@smithy/node-http-handler` — License: Apache-2.0 — https://github.com/smithy-lang/smithy-typescript
- `http-proxy-agent` — License: MIT — https://github.com/TooTallNate/proxy-agents
- `https-proxy-agent` — License: MIT — https://github.com/TooTallNate/proxy-agents
- `partial-json` — License: MIT — https://github.com/promplate/partial-json-parser-js
- `typebox` — License: MIT — https://github.com/sinclairzx81/typebox
- `@earendil-works/chord` — License: MIT — https://github.com/earendil-works/pi
- `@earendil-works/pi-telemetry` — License: MIT — https://github.com/earendil-works/pi
- `diff` — License: BSD-3-Clause — https://github.com/kpdecker/jsdiff
- `ignore` — License: MIT — https://github.com/kaelzhang/node-ignore
- `yaml` — License: ISC — https://github.com/eemeli/yaml

## CozyClay license scope

The CozyClay combined work in this repository is distributed under AGPL-3.0-or-later, subject to the transition details in `LICENSING.md`. That license does not replace or relicense Three.js, ARDY, ARDY model checkpoints, the bundled fonts, the character rigs, or any other third-party component.
