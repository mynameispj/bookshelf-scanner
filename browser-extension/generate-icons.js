#!/usr/bin/env node
// Generates PNG icons for the Chrome extension using Sharp (already a project dep).
// Run once from the repo root: node browser-extension/generate-icons.js

const path = require('path');
// Resolve sharp from the project root's node_modules when run from browser-extension/
const sharp = require(require.resolve('sharp', { paths: [path.join(__dirname, '..')] }));

const sizes = [16, 48, 128];
const outDir = path.join(__dirname, 'icons');

async function makeIcon(size) {
  // Green circle with a white book shape drawn in SVG
  const half   = size / 2;
  const stroke = Math.max(1, Math.round(size * 0.06));
  const pad    = Math.round(size * 0.18);
  const bw     = size - pad * 2;           // book width
  const bh     = Math.round(bh_calc(size)); // book height
  const bx     = pad;
  const by     = Math.round((size - bh) / 2);
  const spineX = bx + Math.round(bw * 0.22);

  function bh_calc(s) { return s - s * 0.28; }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <circle cx="${half}" cy="${half}" r="${half}" fill="#2d6a4f"/>
  <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${Math.max(1,Math.round(size*0.04))}"
        fill="white" opacity="0.95"/>
  <line x1="${spineX}" y1="${by}" x2="${spineX}" y2="${by + bh}"
        stroke="#2d6a4f" stroke-width="${stroke}" opacity="0.5"/>
  <line x1="${bx}" y1="${by + Math.round(bh*0.35)}" x2="${bx + bw}" y2="${by + Math.round(bh*0.35)}"
        stroke="#2d6a4f" stroke-width="${Math.max(1,Math.round(stroke*0.6))}" opacity="0.3"/>
  <line x1="${bx}" y1="${by + Math.round(bh*0.55)}" x2="${bx + bw}" y2="${by + Math.round(bh*0.55)}"
        stroke="#2d6a4f" stroke-width="${Math.max(1,Math.round(stroke*0.6))}" opacity="0.3"/>
  </svg>`;

  const outFile = path.join(outDir, `icon-${size}.png`);
  await sharp(Buffer.from(svg)).png().toFile(outFile);
  console.log(`Created ${outFile}`);
}

(async () => {
  const fs = require('fs');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  for (const size of sizes) {
    await makeIcon(size);
  }
  console.log('Icons generated successfully.');
})();
