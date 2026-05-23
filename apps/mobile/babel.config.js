module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    // react-native-reanimated/plugin MUST be last in the list. This is
    // a hard requirement of reanimated — without it, worklets won't be
    // converted and the runtime explodes on first use.
    plugins: ["react-native-reanimated/plugin"],
  };
};
