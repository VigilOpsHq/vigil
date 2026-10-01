// Generates the social images in public/social/ from one source of truth.
//
//   node scripts/make-social.mjs
//
// Text is converted to outlines, so the output is identical everywhere and
// needs no fonts installed. The IBM Plex files are fetched on first run and
// cached in .fonts/ (git-ignored); the repo keeps the rendered PNGs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const fontDir = path.join(root, '.fonts');
const outDir = path.join(root, 'public', 'social');

const INK = '#0B0F14';
const MINT = '#33D6B0';
const PAPER = '#F5F3EE';
const MUTED = '#7D93A1';

const FONTS = {
  bold: 'ibm-plex-sans-latin-700-normal.woff',
  semi: 'ibm-plex-sans-latin-600-normal.woff',
  body: 'ibm-plex-sans-latin-400-normal.woff',
  mono: 'ibm-plex-mono-latin-500-normal.woff',
};
const CDN = 'https://cdn.jsdelivr.net/npm/@fontsource';
const CDN_PATH = {
  bold: 'ibm-plex-sans@latest/files/ibm-plex-sans-latin-700-normal.woff',
  semi: 'ibm-plex-sans@latest/files/ibm-plex-sans-latin-600-normal.woff',
  body: 'ibm-plex-sans@latest/files/ibm-plex-sans-latin-400-normal.woff',
  mono: 'ibm-plex-mono@latest/files/ibm-plex-mono-latin-500-normal.woff',
};

async function loadFonts() {
  fs.mkdirSync(fontDir, { recursive: true });
  const loaded = {};
  for (const [key, file] of Object.entries(FONTS)) {
    const local = path.join(fontDir, file);
    if (!fs.existsSync(local)) {
      const res = await fetch(`${CDN}/${CDN_PATH[key]}`);
      if (!res.ok) throw new Error(`Could not fetch ${file}: ${res.status}`);
      fs.writeFileSync(local, Buffer.from(await res.arrayBuffer()));
      console.log(`  fetched ${file}`);
    }
    const buf = fs.readFileSync(local);
    loaded[key] = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }
  return loaded;
}

/**
 * One glyph's outline, transformed from font units to the page.
 *
 * The commands are read straight off the cached outline and transformed here,
 * rather than through glyph.getPath(): that returned NaN control points for
 * glyphs drawn a second time at a different size, which silently produced
 * mangled letters. Contours also arrive without Z, so each one is closed —
 * otherwise counters aren't subtracted and letters like o and e fill solid.
 */
function glyphPath(glyph, penX, baselineY, scale, where) {
  const num = (v) => {
    if (!Number.isFinite(v)) throw new Error(`Non-finite coordinate in ${where}`);
    return v.toFixed(2);
  };
  const X = (v) => num(penX + v * scale);
  const Y = (v) => num(baselineY - v * scale);

  const out = [];
  let open = false;
  for (const c of glyph.path.commands) {
    switch (c.type) {
      case 'M':
        if (open) out.push('Z');
        out.push(`M${X(c.x)} ${Y(c.y)}`);
        open = true;
        break;
      case 'L': out.push(`L${X(c.x)} ${Y(c.y)}`); break;
      case 'C': out.push(`C${X(c.x1)} ${Y(c.y1)} ${X(c.x2)} ${Y(c.y2)} ${X(c.x)} ${Y(c.y)}`); break;
      case 'Q': out.push(`Q${X(c.x1)} ${Y(c.y1)} ${X(c.x)} ${Y(c.y)}`); break;
      case 'Z': out.push('Z'); open = false; break;
      default: break;
    }
  }
  if (open) out.push('Z');
  return out.join('');
}

/**
 * One line of text as outlines. anchor: start | middle | end
 *
 * Emitted one path per glyph on purpose: the SVG rasteriser silently truncates
 * path data past roughly 4 KB, which swallowed the back half of every headline.
 */
function text(fonts, str, { font = 'bold', size, x, y, fill = PAPER, anchor = 'start', opacity = 1 }) {
  const f = fonts[font];
  const width = f.getAdvanceWidth(str, size);
  const left = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
  const scale = size / f.unitsPerEm;
  const glyphs = f.stringToGlyphs(str);

  let pen = left;
  const parts = [];
  glyphs.forEach((glyph, i) => {
    const d = glyphPath(glyph, pen, y, scale, `${str}[${i}]`);
    if (d) parts.push(`<path d="${d}" fill="${fill}"/>`);
    pen += glyph.advanceWidth * scale;
    const next = glyphs[i + 1];
    if (next) pen += (f.getKerningValue(glyph, next) || 0) * scale;
  });

  const group = opacity < 1 ? `<g opacity="${opacity}">${parts.join('')}</g>` : parts.join('');
  return { svg: group, width };
}

const widthOf = (fonts, str, font, size) => fonts[font].getAdvanceWidth(str, size);

/** The VigilOps mark, drawn at any size from the 120pt original */
function mark(x, y, size, { bg = MINT, fg = INK } = {}) {
  const s = size / 120;
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <rect x="4" y="4" width="112" height="112" rx="28" fill="${bg}"/>
    <path d="M32 36 L58 76 L88 32" fill="none" stroke="${fg}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="82" cy="57" r="7" fill="${fg}"/>
  </g>`;
}

/** Faint dot grid, so the flat background has some texture at full size */
function grid(w, h, step = 40) {
  const dots = [];
  for (let x = step; x < w; x += step) {
    for (let y = step; y < h; y += step) dots.push(`<circle cx="${x}" cy="${y}" r="1"/>`);
  }
  return `<g fill="${PAPER}" opacity="0.05">${dots.join('')}</g>`;
}

/** A terminal line: mint prompt, paper command */
function prompt(fonts, cmd, { x, y, size }) {
  const dollar = text(fonts, '$', { font: 'mono', size, x, y, fill: MINT });
  const gap = widthOf(fonts, '$ ', 'mono', size);
  const rest = text(fonts, cmd, { font: 'mono', size, x: x + gap, y, fill: PAPER, opacity: 0.92 });
  return dollar.svg + rest.svg;
}

function ogImage(fonts, w, h) {
  const pad = Math.round(w * 0.067);
  const cmd = 'curl -fsSL https://vigilops.cloud/install.sh | sudo sh';
  const cmdSize = Math.round(w * 0.0195);
  const cmdWidth = widthOf(fonts, `$ ${cmd}`, 'mono', cmdSize);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="${w}" height="${h}" fill="${INK}"/>
    ${grid(w, h)}
    ${mark(pad, pad, 64)}
    ${text(fonts, 'VigilOps', { size: 38, x: pad + 84, y: pad + 46 }).svg}

    ${text(fonts, 'Ops automation for', { size: Math.round(w * 0.0583), x: pad, y: h * 0.52 }).svg}
    ${text(fonts, 'a single Docker server.', { size: Math.round(w * 0.0583), x: pad, y: h * 0.52 + w * 0.065 }).svg}

    <rect x="${pad}" y="${h * 0.70}" width="${cmdWidth + 48}" height="${cmdSize * 2.4}" rx="8"
          fill="${PAPER}" opacity="0.06"/>
    ${prompt(fonts, cmd, { x: pad + 24, y: h * 0.70 + cmdSize * 1.6, size: cmdSize })}

    ${text(fonts, 'Open source  ·  MIT licensed  ·  Ubuntu and Debian  ·  amd64 and arm64', {
      font: 'body', size: Math.round(w * 0.0158), x: pad, y: h - pad * 0.72, fill: MUTED,
    }).svg}
    <rect x="0" y="${h - 8}" width="${w}" height="8" fill="${MINT}"/>
  </svg>`;
}

function xHeader(fonts, w, h) {
  // Centred: X crops the sides on mobile and drops the avatar over the bottom
  // left on desktop, so the middle is the only reliably visible part.
  const cx = w / 2;
  const markSize = 64;
  const nameSize = 48;
  const gap = 20;
  const nameWidth = widthOf(fonts, 'VigilOps', 'bold', nameSize);
  const blockWidth = markSize + gap + nameWidth;
  const left = cx - blockWidth / 2;
  const top = h * 0.33;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="${w}" height="${h}" fill="${INK}"/>
    ${grid(w, h, 44)}
    ${mark(left, top, markSize)}
    ${text(fonts, 'VigilOps', { size: nameSize, x: left + markSize + gap, y: top + markSize * 0.76 }).svg}
    ${text(fonts, 'It restarts what breaks, backs up your databases, and asks first.', {
      font: 'body', size: 26, x: cx, y: top + markSize + 54, anchor: 'middle', fill: PAPER, opacity: 0.84,
    }).svg}
    ${text(fonts, 'vigilops.cloud', {
      font: 'mono', size: 22, x: cx, y: top + markSize + 98, anchor: 'middle', fill: MINT,
    }).svg}
    <rect x="0" y="${h - 6}" width="${w}" height="6" fill="${MINT}"/>
  </svg>`;
}

function avatar(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 120 120">
    <rect width="120" height="120" fill="${MINT}"/>
    <path d="M32 36 L58 76 L88 32" fill="none" stroke="${INK}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="82" cy="57" r="7" fill="${INK}"/>
  </svg>`;
}

const run = async () => {
  const fonts = await loadFonts();
  fs.mkdirSync(outDir, { recursive: true });

  const jobs = [
    ['og.png', ogImage(fonts, 1200, 630)],
    ['github-social.png', ogImage(fonts, 1280, 640)],
    ['x-header.png', xHeader(fonts, 1500, 500)],
    ['avatar-512.png', avatar(512)],
  ];

  for (const [name, svg] of jobs) {
    const file = path.join(outDir, name);
    await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(file);
    const { size } = fs.statSync(file);
    const meta = await sharp(file).metadata();
    console.log(`  ${name.padEnd(20)} ${meta.width}x${meta.height}  ${(size / 1024).toFixed(0)} KB`);
  }
};

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
