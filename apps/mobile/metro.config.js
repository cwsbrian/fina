const fs = require("fs");
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);
const googleSigninPackageRoot = path.dirname(
  require.resolve("@react-native-google-signin/google-signin/package.json"),
);
const googleSigninApiEntrypoint = path.join(
  googleSigninPackageRoot,
  "lib/module/signIn/GoogleSignin.js",
);

// pnpm monorepo: watch the workspace root so changes outside apps/mobile
// are picked up, and let Metro fall through to the hoisted node_modules.
config.watchFolders = [...new Set([...(config.watchFolders ?? []), workspaceRoot])];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// Exclude git worktrees from Metro's file watcher. Each worktree has its
// own node_modules; pnpm install/upgrade in the parent repo writes
// short-lived tmp files inside those nested node_modules, which Metro's
// FallbackWatcher crashes on (ENOENT during fs.watch). Block them here.
config.resolver.blockList = [
  ...(Array.isArray(config.resolver.blockList) ? config.resolver.blockList : []),
  /\/\.claude\/worktrees\/.*/,
  /\/\.worktrees\/.*/,
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
  if (moduleName === "@react-native-google-signin/google-signin/native") {
    return { type: "sourceFile", filePath: googleSigninApiEntrypoint };
  }
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
