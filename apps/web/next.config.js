//@ts-check

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { composePlugins, withNx } = require("@nx/next");

/**
 * @type {import('@nx/next/plugins/with-nx').WithNxOptions}
 **/
const nextConfig = {
  nx: {
    // Set this to true if you would like to use SVGR
    // See: https://github.com/gregberge/svgr
    svgr: false,
  },
  // @fina/shared uses NodeNext-style `.js` suffix imports in its TS source
  // (e.g. `from "./roles.js"`). With moduleResolution: "Bundler" the
  // package's TS compiles fine, but webpack at build time resolves the
  // string literally and 404s. Two-part fix:
  //  1. transpilePackages — Next runs the package through its TS loader.
  //  2. extensionAlias — webpack treats `.js` as also resolvable to `.ts`
  //     so `./roles.js` finds `./roles.ts`.
  transpilePackages: ["@fina/shared"],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
  // Proxy /api-proxy/* → backend API so E2E tests stay same-origin.
  // The browser at localhost:3100 calls /api-proxy/... which Next.js
  // rewrites to the real API server. Cookie domain is localhost:3100 so
  // SameSite=Lax is fully respected without cross-port issues.
  async rewrites() {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
    return [
      { source: "/api-proxy/:path*", destination: `${apiUrl}/:path*` },
    ];
  },
};

const plugins = [
  // Add more Next.js plugins to this list if needed.
  withNx,
];

module.exports = composePlugins(...plugins)(nextConfig);
