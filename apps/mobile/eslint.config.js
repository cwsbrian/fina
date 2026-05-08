const baseConfig = require("../../eslint.config.js");

module.exports = [
  ...baseConfig,
  { ignores: [".expo", "web-build", "cache", "dist"] },
];
