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
    },
    output: {
      path: __dirname + '/dist',
      filename: "../main.js",
      libraryTarget: "commonjs",
    },
  };