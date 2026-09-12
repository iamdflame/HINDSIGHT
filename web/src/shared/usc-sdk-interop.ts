// The SDK is CommonJS that sets `__esModule` without providing `exports.default`. Rollup (build)
// resolves a default import to `module.exports`; Vite's dev interop resolves it to
// `exports.default`, which is undefined — so `lib/proof.ts`'s `import sdk from '@gluwa/usc-sdk'`
// crashed under `vite dev` only. `lib` stays untouched; this module is aliased in vite.config.ts so
// both environments hand it the same object.
import * as ns from '@gluwa/usc-sdk/dist/index.js';

const mod: any = (ns as any).proofProvider ? ns : (ns as any).default;
export default mod;
