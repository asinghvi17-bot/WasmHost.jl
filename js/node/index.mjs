// @wasmhost/node: WasmHost's Node adapter (see README.md).
export { wrapWasi, serve } from './spool.mjs';
export { makeImports } from './imports.mjs';
export { perform } from './http.mjs';
export { decompressFile, hasZstd } from './decompress.mjs';
export { detectPlatform, platformEnv, PLATFORM_VAR } from './platform.mjs';
export { makeMapper } from './paths.mjs';
export { runtime, wasiImportObject, wasiInitialize, jspiGap } from './wasi.mjs';
export { makeBridge, encodeFrame, decodeFrame } from '../common/bridge.mjs';
