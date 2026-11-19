// Inlines fonts and modules into one self-contained dist/index.html.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const strip = f => readFileSync(f, 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '');
const font = (fam, file, w) => `@font-face{font-family:${fam};src:url(data:font/woff2;base64,${readFileSync('assets/' + file).toString('base64')}) format('woff2');font-weight:${w};font-display:swap}`;
const fonts = [font('Plex', 'ibm-plex-sans-latin-300-normal.woff2', 300), font('Plex', 'ibm-plex-sans-latin-400-normal.woff2', 400), font('Plex', 'ibm-plex-sans-latin-500-normal.woff2', 500), font('PlexMono', 'ibm-plex-mono-latin-400-normal.woff2', 400), font('PlexMono', 'ibm-plex-mono-latin-500-normal.woff2', 500)].join('\n');
const app = ["src/data.js", "src/engine.js", "src/agent.js", "src/app.js"].map(strip).join('\n');
const html = readFileSync('index.html', 'utf8').replace('/*FONTS*/', fonts).replace('/*APP*/', app);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', html);
console.log('dist/index.html', (html.length / 1024).toFixed(0) + ' KB');
