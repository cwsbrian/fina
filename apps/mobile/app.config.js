// Dynamic Expo config layered on top of app.json.
//
// 1. Cleartext HTTP: enabled ONLY for dev/preview builds whose API URL is
//    plain http:// (e.g. the Tailscale LAN dev server). Production uses
//    https://, so cleartext stays disabled there.
// 2. Low-resource local builds: when FINA_LOCAL_BUILD=1 (set by the local
//    eas.json profiles), cap the Android build so `eas build --local` doesn't
//    exhaust RAM and thrash swap to a disk-I/O standstill on a small machine
//    (e.g. a ~10 GB WSL2). EAS cloud / production builds leave this unset and
//    keep full ABIs + parallelism.
const { withGradleProperties } = require("expo/config-plugins");

/** Set (replacing any existing) a gradle.properties key. */
function setGradleProperty(props, key, value) {
  const next = props.filter(
    (item) => !(item.type === "property" && item.key === key),
  );
  next.push({ type: "property", key, value });
  return next;
}

/** Cap Gradle heap + worker parallelism for low-RAM local builds. The big RAM
 *  saver is the single-ABI limit (set via expo-build-properties below); this
 *  keeps the Gradle daemon + concurrent task count from piling on top of the
 *  native (CMake/ninja) compile. */
const withLocalBuildLimits = (config) =>
  withGradleProperties(config, (cfg) => {
    // One ABI instead of all four cuts the New-Architecture C++ compile ~4x —
    // the phase that otherwise exhausts RAM. Set it here (not via
    // expo-build-properties, whose reactNativeArchitectures option did NOT take
    // effect — the prebuild template's default won) so this mod, which runs
    // last, overwrites the default. arm64-v8a covers modern test devices + the
    // Play internal track.
    cfg.modResults = setGradleProperty(
      cfg.modResults,
      "reactNativeArchitectures",
      "arm64-v8a",
    );
    cfg.modResults = setGradleProperty(
      cfg.modResults,
      "org.gradle.jvmargs",
      "-Xmx4096m -XX:MaxMetaspaceSize=1024m",
    );
    cfg.modResults = setGradleProperty(cfg.modResults, "org.gradle.workers.max", "2");
    cfg.modResults = setGradleProperty(cfg.modResults, "org.gradle.parallel", "false");
    return cfg;
  });

module.exports = ({ config }) => {
  const apiUrl = process.env.EXPO_PUBLIC_API_URL || "";
  const allowCleartext = apiUrl.startsWith("http://");
  const lowResource = process.env.FINA_LOCAL_BUILD === "1";

  // expo-build-properties is only needed for cleartext HTTP (its
  // reactNativeArchitectures option didn't take effect — the ABI limit is set
  // in withLocalBuildLimits via gradle.properties instead).
  if (allowCleartext) {
    config.plugins = [
      ...(config.plugins || []),
      ["expo-build-properties", { android: { usesCleartextTraffic: true } }],
    ];
  }

  if (lowResource) {
    config = withLocalBuildLimits(config);
  }

  return config;
};
