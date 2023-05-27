module.exports = {
    mode: "development",
    entry: "./main.tsx",
    module: {
      rules: [
        {
          test: /\.(ts|tsx)$/,
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
        extensions: [".js", ".jsx", ".json", ".ts", ".tsx"],
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