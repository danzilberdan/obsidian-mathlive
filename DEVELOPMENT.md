# Development

Use a symlink so your vault loads this repo directly.

1. Install dependencies with `npm install`.
2. Link the repo into an existing vault with `npm run link-vault -- "/path/to/YourVault"`.
3. Start the watch build with `npm run dev`.
4. In that vault, enable the `MathLive` community plugin.

The symlink is created at `"/path/to/YourVault/.obsidian/plugins/mathlive"` and points to this repository, so rebuilt `main.js` is immediately visible to Obsidian.

Obsidian does not always reload changed plugin code automatically. Reload the plugin or restart Obsidian after a rebuild, or use a community plugin such as Hot Reload if you want automatic plugin reloads while developing.

If `mathlive` already exists in your vault as a normal folder, move or delete that folder before running the link command.
## Help index

The help window's "How to…" search (help.ts, help-search.ts) runs on the device over two files in help/:

- `help/topics.json`: hand-written topics, the "Getting started" list and plugin features.
- `help/mathlive-docs.json`: made from the MathLive docs site. When the docs change, rebuild it with
  `git clone --depth 1 https://github.com/cortex-js/cortexjs.io /tmp/cortexjs.io && node scripts/build-help-index.mjs /tmp/cortexjs.io`.

`npm run eval:help` checks that 70 or so questions find the right answer in the top 3. Add a question there when you add a topic.
