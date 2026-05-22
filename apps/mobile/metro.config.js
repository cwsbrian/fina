const fs = require("fs");
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// pnpm monorepo: watch the workspace root so changes outside apps/mobile
// are picked up, and let Metro fall through to the hoisted node_modules.
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// SVG support via react-native-svg-transformer
const { assetExts, sourceExts } = config.resolver;
config.transformer = {
  ...config.transformer,
  babelTransformerPath: require.resolve("react-native-svg-transformer"),
};
config.resolver.assetExts = assetExts.filter((ext) => ext !== "svg");
config.resolver.sourceExts = [...sourceExts, "svg"];

// @fina/shared is authored in TS using the TypeScript-ESM convention
// `import "./foo.js"` from `foo.ts`. Web handles this via Next.js
// extensionAlias; Metro needs the equivalent. Rewrite relative `.js`
// imports to `.ts` (and `.jsx` → `.tsx`) when the TS source exists.
const baseResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    (moduleName.endsWith(".js") || moduleName.endsWith(".jsx")) &&
    (moduleName.startsWith("./") || moduleName.startsWith("../"))
  ) {
    const tsCandidate = moduleName.replace(/\.jsx?$/, (m) =>
      m === ".js" ? ".ts" : ".tsx",
    );
    const originDir = path.dirname(context.originModulePath);
    const absolute = path.resolve(originDir, tsCandidate);
    if (fs.existsSync(absolute)) {
      return context.resolveRequest(context, tsCandidate, platform);
    }
  }
  if (baseResolveRequest) {
    return baseResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
