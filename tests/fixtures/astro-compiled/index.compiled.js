import { render as $$render, createComponent as $$createComponent, maybeRenderHead as $$maybeRenderHead, defineScriptVars as $$defineScriptVars } from "astro/compiler-runtime";
const $$Index = $$createComponent(($$result, $$props, $$slots) => {
	console.log("protected frontmatter");
	console.log("stripped frontmatter");
	console.debug("protected block");
	const tag = `<script>console.log('frontmatter template')<\/script>`;
	return $$render`${$$maybeRenderHead($$result)}<p>${console.log("stripped template")}</p><p>${console.log("protected template")}</p><script>
	console.log(\`inline \${tag}\\\\\`);
	console.info('kept inline');
	// console-stripper-ignore-next-line
	console.log('protected inline');
<\/script><script>(function(){${$$defineScriptVars({ tag })}
	console.log('define:vars', tag);
})();<\/script><script type="application/json">{"console.log(1)": 1}<\/script>${tag && $$render`<script>console.log('nested')<\/script>`}`;
}, "/project/src/pages/index.astro", undefined);
export default $$Index;

//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6W10sInNvdXJjZXMiOlsiL3Byb2plY3Qvc3JjL3BhZ2VzL2luZGV4LmFzdHJvIl0sInNvdXJjZXNDb250ZW50IjpbIi0tLVxuLy8gY29uc29sZS1zdHJpcHBlci1pZ25vcmUtbmV4dC1saW5lXG5jb25zb2xlLmxvZygncHJvdGVjdGVkIGZyb250bWF0dGVyJyk7XG5jb25zb2xlLmxvZygnc3RyaXBwZWQgZnJvbnRtYXR0ZXInKTtcbi8qIGNvbnNvbGUtc3RyaXBwZXItaWdub3JlLXN0YXJ0ICovXG5jb25zb2xlLmRlYnVnKCdwcm90ZWN0ZWQgYmxvY2snKTtcbi8qIGNvbnNvbGUtc3RyaXBwZXItaWdub3JlLWVuZCAqL1xuY29uc3QgdGFnID0gYDxzY3JpcHQ+Y29uc29sZS5sb2coJ2Zyb250bWF0dGVyIHRlbXBsYXRlJyk8L3NjcmlwdD5gO1xuLS0tXG48cD57Y29uc29sZS5sb2coJ3N0cmlwcGVkIHRlbXBsYXRlJyl9PC9wPlxuey8qIGNvbnNvbGUtc3RyaXBwZXItaWdub3JlLW5leHQtbGluZSAqL31cbjxwPntjb25zb2xlLmxvZygncHJvdGVjdGVkIHRlbXBsYXRlJyl9PC9wPlxuPHNjcmlwdCBpczppbmxpbmU+XG5cdGNvbnNvbGUubG9nKGBpbmxpbmUgJHt0YWd9XFxcXGApO1xuXHRjb25zb2xlLmluZm8oJ2tlcHQgaW5saW5lJyk7XG5cdC8vIGNvbnNvbGUtc3RyaXBwZXItaWdub3JlLW5leHQtbGluZVxuXHRjb25zb2xlLmxvZygncHJvdGVjdGVkIGlubGluZScpO1xuPC9zY3JpcHQ+XG48c2NyaXB0IGlzOmlubGluZSBkZWZpbmU6dmFycz17eyB0YWcgfX0+XG5cdGNvbnNvbGUubG9nKCdkZWZpbmU6dmFycycsIHRhZyk7XG48L3NjcmlwdD5cbjxzY3JpcHQgaXM6aW5saW5lIHR5cGU9XCJhcHBsaWNhdGlvbi9qc29uXCI+e1wiY29uc29sZS5sb2coMSlcIjogMX08L3NjcmlwdD5cbnt0YWcgJiYgPHNjcmlwdCBpczppbmxpbmU+Y29uc29sZS5sb2coJ25lc3RlZCcpPC9zY3JpcHQ+fVxuIl0sIm1hcHBpbmdzIjoiOztBQUVBLFNBQUEsSUFBQSx3QkFBQTtBQUNBLFNBQUEsSUFBQSx1QkFBQTtBQUVBLFNBQUEsTUFBQSxrQkFBQTtDQUVBLE1BQUEsTUFBQTsrQ0FFQSxHQUFHLEVBQUMsUUFBQSxJQUFZLG9CQUFBLENBQXFCLElBQUksR0FFdEMsRUFBQyxRQUFBLElBQVkscUJBQUEsQ0FBc0IsSUFBSSxRQUN4Qjs7Ozs7Z0NBTWxCLG1CQUFBLEVBQUEsS0FBQSxDQUFBLENBQUE7O2VBRVMsT0FDUyx5QkFBd0IscUJBQXFCLFVBQVMsRUFDdkUsT0FBQSxRQUFBLENBQU8sUUFBa0IscUJBQXFCIn0=
const $$file = "/project/src/pages/index.astro";
const $$url = "";export { $$file as file, $$url as url };
