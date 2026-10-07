// Baut aus index.html/style.css/app.js/lib eine einzelne Seite (dist/) für claude.ai oder jeden Webserver.
// Aufruf: node build.js
const fs = require('fs'), path = require('path');
const proj = __dirname, out = path.join(__dirname, "dist");
fs.mkdirSync(out, { recursive: true });
const read = f => fs.readFileSync(path.join(proj, f), 'utf8');
const html = read('index.html'), css = read('style.css'), app = read('app.js');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script src="lib/lame.min.js">'));
const fonts = html.match(/<link rel="stylesheet" href="https:\/\/fonts[^>]+>/)[0];
const page = `<title>TipsyRemix</title>
<meta name="apple-mobile-web-app-capable" content="yes">
${fonts}
<style>
${css}
</style>
${body.trim()}
<!-- lamejs (LGPL-3.0) bleibt eine eigene, austauschbare Datei – siehe THIRD_PARTY_NOTICES.txt -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js"></script>
<script>
${app}
</script>
`;
fs.writeFileSync(path.join(out, 'index.html'), page);
const w = app.match(/const WORKLET_CODE = `([\s\S]*?)`;/)[1];
fs.writeFileSync(path.join(out, "worklet.js"), w);
// auch im Projekt-Hauptordner: GitHub Pages lädt das Audio-Modul von dort (zuverlässiger als data:-URL in Safari)
fs.writeFileSync(path.join(proj, 'worklet.js'), '// Automatisch aus app.js (WORKLET_CODE) erzeugt – nicht von Hand ändern, sondern: node build.js\n' + w);
console.log('index.html', (page.length / 1024).toFixed(0) + ' KB; worklet.js', w.length, 'Zeichen');
