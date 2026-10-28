// Webpack loader for the Compute Engine: takes out its `new Function` calls, which only its
// compile() feature uses. MathLive never compiles expressions, and a plugin should carry no code
// that builds code at run time.
module.exports = function (source) {
	const out = source.replace(
		/new Function\(/g,
		'(() => { throw new Error("MathLive: compiled expressions are turned off."); })('
	);
	if (/new Function\b/.test(out)) {
		throw new Error("no-dynamic-code-loader: a new Function call is left");
	}
	return out;
};
