const baseConfig = require("../../eslint.config.js");
const nxPlugin = require("@nx/eslint-plugin");

module.exports = [
  ...baseConfig,
  {
    files: ["**/*.json"],
    plugins: { "@nx": nxPlugin },
    rules: {
      "@nx/dependency-checks": [
        "error",
        { ignoredFiles: ["{projectRoot}/eslint.config.{js,cjs,mjs}"] },
      ],
    },
    languageOptions: { parser: require("jsonc-eslint-parser") },
  },
];
