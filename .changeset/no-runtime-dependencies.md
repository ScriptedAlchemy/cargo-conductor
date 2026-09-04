---
'cargo-hauler': patch
---

Declare no runtime `dependencies`: `npm install -g cargo-hauler` fetches one tarball and nothing else. 0.4.7 listed the build-time stack (`@agent-bundle/runtime` as a pkg.pr.new tarball, `bashjsast` as a `github:` ref, `effect`, `react`, `zod`, …) under `dependencies` even though every shipped file bundles what it uses, so npm 12's default `allow-remote=none` / `allow-git=none` refused the install with `EALLOWREMOTE`. The whole stack now lives under `devDependencies`; the emitted packs and `dist/bin` executables are unchanged. (#PR)
