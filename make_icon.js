/**
 * make_icon.js — Renders Claude logo SVG to PNG using sharp + svg2img
 * Run: node make_icon.js
 * Requires: npm install sharp
 */
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

const OUT = path.join(__dirname, 'resources');
fs.mkdirSync(OUT, { recursive: true });

// Find Claude Code SVG
const extRoot = path.join(os.homedir(), '.vscode', 'extensions');
const claudeDir = fs.readdirSync(extRoot).find(d => d.startsWith('anthropic.claude-code-'));
const svgPath = path.join(extRoot, claudeDir, 'resources', 'claude-logo.svg');
const svgOrig = fs.readFileSync(svgPath, 'utf8');

// Recolor helpers
const white = svgOrig.replace(/#D97757/g, 'white').replace(/width="1em"/, 'width="200"').replace(/height="1em"/, 'height="200"');
const black = svgOrig.replace(/#D97757/g, 'black').replace(/width="1em"/, 'width="200"').replace(/height="1em"/, 'height="200"');

fs.writeFileSync(path.join(OUT, '_tmp_white.svg'), white);
fs.writeFileSync(path.join(OUT, '_tmp_black.svg'), black);

// Check sharp
try { require.resolve('sharp'); } catch(e) {
    console.log('Installing sharp...');
    execSync('npm install sharp', { cwd: __dirname, stdio: 'inherit' });
}
const sharp = require('sharp');

async function main() {
    // dark theme: white logo, transparent bg
    await sharp(Buffer.from(white), { density: 300 })
        .resize(32, 32)
        .png()
        .toFile(path.join(OUT, 'icon-dark.png'));
    console.log('icon-dark.png done');

    // light theme: black logo, transparent bg
    await sharp(Buffer.from(black), { density: 300 })
        .resize(32, 32)
        .png()
        .toFile(path.join(OUT, 'icon-light.png'));
    console.log('icon-light.png done');

    // marketplace: white logo on black circle, 128x128
    const logoWhite = await sharp(Buffer.from(white), { density: 300 })
        .resize(100, 100)
        .png()
        .toBuffer();

    const circle = Buffer.from(`<svg width="128" height="128" xmlns="http://www.w3.org/2000/svg">
        <circle cx="64" cy="64" r="64" fill="black"/>
    </svg>`);

    await sharp(circle)
        .composite([{ input: logoWhite, gravity: 'center' }])
        .png()
        .toFile(path.join(OUT, 'icon.png'));
    console.log('icon.png done');

    // cleanup
    fs.unlinkSync(path.join(OUT, '_tmp_white.svg'));
    fs.unlinkSync(path.join(OUT, '_tmp_black.svg'));
    console.log('All done.');
}

main().catch(e => { console.error(e); process.exit(1); });
