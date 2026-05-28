// Dynamic Expo config layered on top of app.json.
// Enables Android cleartext HTTP ONLY for dev/preview builds whose API URL is
// plain http:// (e.g. the Tailscale LAN dev server). Production uses https://,
// so cleartext stays disabled there and the prod app keeps its default posture.
module.exports = ({ config }) => {
  const apiUrl = process.env.EXPO_PUBLIC_API_URL || "";
  const allowCleartext = apiUrl.startsWith("http://");

  if (allowCleartext) {
    config.plugins = [
      ...(config.plugins || []),
      ["expo-build-properties", { android: { usesCleartextTraffic: true } }],
    ];
  }

  return config;
};
