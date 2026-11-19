// Inlines fonts and modules into one self-contained dist/index.html.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const strip = f => readFileSync(f, 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '');
const font = (fam, file, w) => `@font-face{font-family:${fam};src:url(data:font/woff2;base64,${readFileSync('assets/' + file).toString('base64')}) format('woff2');font-weight:${w};font-display:swap}`;
const fonts = [font('Plex', 'ibm-plex-sans-latin-300-normal.woff2', 300), font('Plex', 'ibm-plex-sans-latin-400-normal.woff2', 400), font('Plex', 'ibm-plex-sans-latin-500-normal.woff2', 500), font('PlexMono', 'ibm-plex-mono-latin-400-normal.woff2', 400), font('PlexMono', 'ibm-plex-mono-latin-500-normal.woff2', 500)].join('\n');
const app = ['src/data.js', 'src/csv.js', 'src/engine.js', 'src/agent.js', 'src/app.js'].map(strip).join('\n');
const html = readFileSync('index.html', 'utf8').replace('/*FONTS*/', fonts).replace('/*APP*/', app);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', html);
// Public build (GitHub Pages): same page, locked down with a Content Security Policy.
// No network access at all: uploaded exports cannot leave the browser even if a script were injected.
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";
mkdirSync('docs', { recursive: true });
writeFileSync('docs/index.html', html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${CSP}">\n<meta name="referrer" content="no-referrer">`));
console.log('dist/index.html', (html.length / 1024).toFixed(0) + ' KB');
