import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "../..");

const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  outputFileTracingRoot: workspaceRoot,
  turbopack: {
    // Handle node: protocol imports by aliasing to non-prefixed versions
    // which Next.js/Turbopack can externalize via serverExternalPackages
    resolveAlias: {
      "node:fs": "fs",
      "node:fs/promises": "fs/promises",
      "node:path": "path",
      "node:os": "os",
      "node:crypto": "crypto",
      "node:stream": "stream",
      "node:util": "util",
      "node:buffer": "buffer",
      "node:querystring": "querystring",
      "node:url": "url",
      "node:zlib": "zlib",
      "node:http": "http",
      "node:https": "https",
      "node:assert": "assert",
      "node:constants": "constants",
      "node:process": "process",
    },
  },
  serverExternalPackages: [
    "@contextio/core",
    "@contextio/logger",
    "@contextio/redact",
    "onnxruntime-node",
    "@huggingface/tokenizers",
    "better-sqlite3",
    // Node.js built-in modules with node: protocol (required for Turbopack dev mode)
    "node:crypto",
    "node:fs",
    "node:fs/promises",
    "node:path",
    "node:os",
    "node:stream",
    "node:util",
    "node:buffer",
    "node:querystring",
    "node:url",
    "node:zlib",
    "node:http",
    "node:https",
    "node:assert",
    "node:constants",
    "node:process",
    // Also include non-node: protocol versions for compatibility
    "crypto",
    "fs",
    "path",
    "os",
    "stream",
    "util",
    "buffer",
    "querystring",
    "url",
    "zlib",
    "http",
    "https",
    "assert",
    "constants",
    "process",
  ],
  webpack: (config, { isServer }) => {
    config.resolve.alias["@"] = path.join(process.cwd(), "");

    // Handle Node.js built-in modules - only apply fallback for client bundle
    const nodeBuiltinFallback = {
      fs: false,
      path: false,
      os: false,
      crypto: false,
      stream: false,
      util: false,
      buffer: false,
      querystring: false,
      url: false,
      zlib: false,
      http: false,
      https: false,
      assert: false,
      constants: false,
      process: false,
      "fs/promises": false,
    };

    // Exclude native Node.js modules from bundling
    const nativeModules = ["onnxruntime-node", "onnxruntime-node/napi", "onnxruntime-web", "sharp", "unrs-resolver", "@huggingface/tokenizers", "better-sqlite3"];

    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        ...nodeBuiltinFallback,
      };
      // Also exclude native modules on client
      nativeModules.forEach((mod) => {
        config.resolve.alias[mod] = false;
      });
    } else {
      // For server bundle, do NOT apply node:* fallbacks - let Node.js handle native modules
      // Only apply non-node: fallbacks to avoid bundling issues
      config.resolve.fallback = {
        ...config.resolve.fallback,
        ...nodeBuiltinFallback,
      };
      // Ensure native modules are treated as external on server
      config.externals = config.externals || [];
      config.externals.push({
        "@contextio/core": "commonjs @contextio/core",
        "@contextio/logger": "commonjs @contextio/logger",
        "@contextio/redact": "commonjs @contextio/redact",
        "onnxruntime-node": "commonjs onnxruntime-node",
      });
      // Externalize all @contextio/core submodules
      config.externals.push((context, request, callback) => {
        if (request.startsWith("@contextio/core")) {
          return callback(null, `commonjs ${request}`);
        }
        callback();
      });
      nativeModules.forEach((mod) => {
        config.externals.push({
          [mod]: `commonjs ${mod}`,
        });
      });
    }
    return config;
  },
};

export default nextConfig;