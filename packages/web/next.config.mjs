import path from "path";

const nextConfig = {
  reactStrictMode: true,
  turbopack: {},
  serverExternalPackages: ["@contextio/logger", "@contextio/redact", "onnxruntime-node", "fs/promises", "path", "os", "crypto", "stream", "util", "buffer", "querystring", "url", "zlib", "http", "https", "assert", "constants", "process"],
  webpack: (config, { isServer }) => {
    config.resolve.alias["@"] = path.join(process.cwd(), "");

    // Handle Node.js built-in modules (node: protocol) for both client and server
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
      "node:crypto": false,
      "node:fs": false,
      "node:fs/promises": false,
      "node:path": false,
      "node:os": false,
      "node:stream": false,
      "node:util": false,
      "node:buffer": false,
      "node:querystring": false,
      "node:url": false,
      "node:zlib": false,
      "node:http": false,
      "node:https": false,
      "node:assert": false,
      "node:constants": false,
      "node:process": false,
    };

    // Exclude native Node.js modules from bundling
    const nativeModules = ["onnxruntime-node", "onnxruntime-node/napi", "onnxruntime-web", "sharp", "unrs-resolver"];

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
      // For server, also add fallback for node: protocol
      config.resolve.fallback = {
        ...config.resolve.fallback,
        ...nodeBuiltinFallback,
      };
      // Ensure native modules are treated as external on server
      config.externals = config.externals || [];
      config.externals.push({
        "@contextio/logger": "commonjs @contextio/logger",
        "@contextio/redact": "commonjs @contextio/redact",
        "onnxruntime-node": "commonjs onnxruntime-node",
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