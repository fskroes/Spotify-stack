# Vendored Tree-sitter WASM grammars

These binaries are deliberately committed. `@fleet/knowledge` executes on macOS and
Linux, so it loads these modules through `web-tree-sitter@0.26.11`, never through
native Node grammar bindings or `node-gyp`.

## Provenance and rebuild record

The checked-in files were extracted from the following npm packages from
[`leandrocp/lumis`](https://github.com/leandrocp/lumis). Each package documents its
upstream parser revision and is built with `tree-sitter build --wasm`; the release
packages below were used unchanged.

| Binary | Distribution and build tool | Grammar source and revision | License |
| --- | --- | --- | --- |
| `tree-sitter-typescript.wasm` | `@lumis-sh/wasm-typescript@0.26.1`; Tree-sitter CLI `0.26.6` | `tree-sitter-typescript@0.23.2`, [`tree-sitter/tree-sitter-typescript`](https://github.com/tree-sitter/tree-sitter-typescript) at `f975a621f4e7f532fe322e13c4f79495e0a7b2e7` | MIT |
| `tree-sitter-tsx.wasm` | `@lumis-sh/wasm-tsx@0.26.1`; Tree-sitter CLI `0.26.6` | `tree-sitter-typescript@0.23.2`, [`tree-sitter/tree-sitter-typescript`](https://github.com/tree-sitter/tree-sitter-typescript) at `f975a621f4e7f532fe322e13c4f79495e0a7b2e7` | MIT |
| `tree-sitter-swift.wasm` | `@lumis-sh/wasm-swift@0.26.1`; Tree-sitter CLI `0.26.9` | `tree-sitter-swift@0.7.3`, [`alex-pinkus/tree-sitter-swift`](https://github.com/alex-pinkus/tree-sitter-swift) at `b8b22bffbb3441780e6471665bacfb263741c86a` | MIT |

To regenerate directly from upstream rather than extracting the recorded release, install
Emscripten (`emcc`) and run the matching Tree-sitter CLI in a scratch directory. Build
TypeScript and TSX from their grammar subdirectories, and Swift from its repository root:

```sh
# TypeScript / TSX
# git clone https://github.com/tree-sitter/tree-sitter-typescript.git && cd tree-sitter-typescript
# git checkout f975a621f4e7f532fe322e13c4f79495e0a7b2e7
(cd typescript && npm exec --package tree-sitter-cli@0.26.6 -- tree-sitter build --wasm)
(cd tsx && npm exec --package tree-sitter-cli@0.26.6 -- tree-sitter build --wasm)

# Swift
# git clone https://github.com/alex-pinkus/tree-sitter-swift.git && cd tree-sitter-swift
# git checkout b8b22bffbb3441780e6471665bacfb263741c86a
npm exec --package tree-sitter-cli@0.26.9 -- tree-sitter build --wasm
```

The release extraction below is the reproducible source of the exact committed
artifacts (in a scratch directory, never as a runtime action):

```sh
npm pack @lumis-sh/wasm-typescript@0.26.1
npm pack @lumis-sh/wasm-tsx@0.26.1
npm pack @lumis-sh/wasm-swift@0.26.1
for grammar in typescript tsx swift; do
  tar -xOf "lumis-sh-wasm-${grammar}-0.26.1.tgz" "package/tree-sitter-${grammar}.wasm" \
    > "packages/knowledge/grammars/tree-sitter-${grammar}.wasm"
done
shasum -a 256 packages/knowledge/grammars/*.wasm
```

## Checksums

```text
0258a7ef17303a8079ffe0748b3583d59656b5c3e8653fca7b6451b3e6689eb2  tree-sitter-swift.wasm
697c5aa64f06c778e202d3ae53dcf60141c7119fac1b86b3b3f2333eef711bf5  tree-sitter-tsx.wasm
3c46090a4fd501dbf1caee425a717d56382abd3f0881410280695d74a1ec6d56  tree-sitter-typescript.wasm
```

Any grammar update must refresh this table and checksums, then run
`pnpm --filter @fleet/knowledge test` on both Linux and macOS. The CI `test` job
covers Linux through the root suite; the macOS `desktop` job runs this focused test
explicitly.
