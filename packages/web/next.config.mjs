import path from "path";

const nextConfig = {
  reactStrictMode: true,
  turbopack: {},
  serverExternalPackages: ["@contextio/logger", "fs/promises", "path", "os", "crypto", "stream", "util", "buffer", "querystring", "url", "zlib", "http", "https", "assert", "constants", "process"],
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
    
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        ...nodeBuiltinFallback,
      };
    } else {
      // For server, also add fallback for node: protocol
      config.resolve.fallback = {
        ...config.resolve.fallback,
        ...nodeBuiltinFallback,
      };
      // Ensure @contextio/logger is treated as external on server
      config.externals = config.externals || [];
      config.externals.push({
        "@contextio/logger": "commonjs @contextio/logger",
      });
    }
    return config;
  },
};

export default nextConfig;