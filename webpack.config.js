const codemirrorExternals = [
	"@codemirror/autocomplete",
	"@codemirror/collab",
	"@codemirror/commands",
	"@codemirror/language",
	"@codemirror/lint",
	"@codemirror/search",
	"@codemirror/state",
	"@codemirror/view",
	"@lezer/common",
	"@lezer/highlight",
	"@lezer/lr",
].reduce((acc, pkg) => {
	acc[pkg] = `commonjs ${pkg}`;
	return acc;
}, {});

const webpack = require("webpack");

module.exports = {
    mode: "development",
    devtool: false,
    entry: "./main.ts",
    module: {
      rules: [
        {
          test: /\.(ts)$/,
          use: "ts-loader",
          exclude: /node_modules/,
        },
        {
            test: /\.css$/,
            loader: "css-loader",
        },
        {
            test: /\.woff2$/,
            type: "asset/inline",
        },
      ],
    },
    resolve: {
        extensions: [".js", ".jsx", ".json", ".ts"],
    },
    externals: {
      obsidian: "commonjs obsidian",
      electron: "commonjs electron",
      ...codemirrorExternals,
    },
    plugins: [
      // The MathLive server the build talks to. Release tags with "-staging" build against staging.
      new webpack.DefinePlugin({
        MATHLIVE_ORIGIN: JSON.stringify(process.env.MATHLIVE_ORIGIN || "https://mathlive.danz.blog"),
        MATHLIVE_VERSION: JSON.stringify(require("./manifest.json").version),
      }),
    ],
    output: {
      path: __dirname + '/dist',
      filename: "../main.js",
      libraryTarget: "commonjs",
    },
  };