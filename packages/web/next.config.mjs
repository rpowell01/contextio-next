import path from "path";

const nextConfig = {
  reactStrictMode: true,
  turbopack: {},
  serverExternalPackages: ["fs/promises", "path", "os", "crypto", "stream", "util", "buffer", "querystring", "url", "zlib", "http", "https", "assert", "constants", "process"],
  webpack: (config, { isServer }) => {
    config.resolve.alias["@"] = path.join(process.cwd(), "");
    if (!isServer) {
      // Handle Node.js built-in modules (node: protocol) for Next.js 15+
      config.resolve.fallback = {
        ...config.resolve.fallback,
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
    }
    return config;
  },
};

export default nextConfig;