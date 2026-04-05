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
    output: {
      path: __dirname + '/dist',
      filename: "../main.js",
      libraryTarget: "commonjs",
    },
  };