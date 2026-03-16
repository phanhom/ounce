/**
 * Bundle the worker daemon into a single self-contained file.
 *
 * Output: dist/paperclip-worker.mjs
 *
 * Usage on any remote machine with Node >= 18:
 *   scp dist/paperclip-worker.mjs user@remote:~/
 *   ssh user@remote 'node paperclip-worker.mjs'
 *
 * All workspace adapter packages are inlined. Only Node built-ins are external.
 */

/** @type {import('esbuild').BuildOptions} */
export default {
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: "dist/paperclip-worker.mjs",
  banner: {
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __$$createRequire } from 'node:module';",
      "const require = __$$createRequire(import.meta.url);",
    ].join("\n"),
  },
  treeShaking: true,
  sourcemap: true,
  // Keep only true Node built-ins external — everything else gets inlined
  external: [
    "node:*",
    "child_process",
    "crypto",
    "events",
    "fs",
    "http",
    "https",
    "net",
    "os",
    "path",
    "stream",
    "tls",
    "url",
    "util",
    "worker_threads",
    "zlib",
  ],
};
