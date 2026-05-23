module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    // Reanimated v4 worklets transformer. Must be the LAST plugin so it
    // sees the fully-transformed AST. Without it, worklet functions run
    // on the wrong runtime and the native module rejects them at boot
    // with "Exception in HostFunction".
    plugins: ["react-native-worklets/plugin"],
  };
};
