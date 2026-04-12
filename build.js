// Build script — copies files to dist/, minifies JS + CSS
const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

const DIST = path.join(__dirname, 'dist');

// Clean and create dist/
if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true });
fs.mkdirSync(DIST);

async function build() {
    // 1. Minify app.js — mangle variable names, strip comments
    const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const appMin = await minify(appSrc, {
        compress: { drop_console: true, passes: 2 },
        mangle: { toplevel: false },  // don't mangle globals (they're shared across files)
        output: { comments: false }
    });
    fs.writeFileSync(path.join(DIST, 'app.js'), appMin.code);

    // 2. Minify config.js
    const cfgSrc = fs.readFileSync(path.join(__dirname, 'config.js'), 'utf8');
    const cfgMin = await minify(cfgSrc, {
        compress: { passes: 1 },
        mangle: false,  // keep BRAND readable (it's the branding config)
        output: { comments: false }
    });
    fs.writeFileSync(path.join(DIST, 'config.js'), cfgMin.code);

    // 3. Minify CSS (simple — strip comments + whitespace)
    const cssSrc = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
    const cssMin = cssSrc
        .replace(/\/\*[\s\S]*?\*\//g, '')  // strip comments
        .replace(/\s+/g, ' ')               // collapse whitespace
        .replace(/\s*([{}:;,>+~])\s*/g, '$1') // strip around symbols
        .trim();
    fs.writeFileSync(path.join(DIST, 'style.css'), cssMin);

    // 4. Copy index.html as-is
    fs.copyFileSync(path.join(__dirname, 'index.html'), path.join(DIST, 'index.html'));

    // Report sizes
    const origSize = appSrc.length;
    const minSize = appMin.code.length;
    console.log(`app.js: ${(origSize/1024).toFixed(0)}KB → ${(minSize/1024).toFixed(0)}KB (${((1-minSize/origSize)*100).toFixed(0)}% smaller)`);
    console.log(`dist/ ready`);
}

build().catch(e => { console.error(e); process.exit(1); });
