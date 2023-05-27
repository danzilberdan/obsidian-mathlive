module.exports = {
    mode: "development",
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