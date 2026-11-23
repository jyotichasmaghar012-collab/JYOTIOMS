'use strict';
/**
 * Best-effort image helpers (port of the Pillow code in the Flask app).
 * Every function here swallows errors - a resize failure leaves the original
 * upload in place and never breaks the request, exactly like the original.
 */
const fs = require('node:fs');
let sharp = null;
try { sharp = require('sharp'); } catch (_) { sharp = null; }

function isJpeg(p) { return /\.(jpe?g)$/i.test(p); }

function encode(pipeline, fullPath, quality) {
  if (isJpeg(fullPath)) return pipeline.jpeg({ quality, mozjpeg: true });
  if (/\.png$/i.test(fullPath)) return pipeline.png();
  if (/\.webp$/i.test(fullPath)) return pipeline.webp({ quality });
  return pipeline;
}

/** Downscale to maxWidth (keeping aspect ratio) if the image is wider. */
async function resizeIfWider(fullPath, maxWidth, quality = 88) {
  if (!sharp || !fullPath) return;
  try {
    const input = fs.readFileSync(fullPath);
    const meta = await sharp(input).metadata();
    if (!meta.width || meta.width <= maxWidth) return;
    let p = sharp(input).rotate().resize({ width: maxWidth, kernel: 'lanczos3' });
    if (isJpeg(fullPath)) p = p.flatten({ background: '#ffffff' });
    const out = await encode(p, fullPath, quality).toBuffer();
    fs.writeFileSync(fullPath, out);
  } catch (_) { /* best effort */ }
}

/** Downscale so neither side exceeds maxSide. */
async function resizeIfLarger(fullPath, maxSide, quality = 88) {
  if (!sharp || !fullPath) return;
  try {
    const input = fs.readFileSync(fullPath);
    const meta = await sharp(input).metadata();
    if (!meta.width || (meta.width <= maxSide && meta.height <= maxSide)) return;
    let p = sharp(input).rotate().resize({ width: maxSide, height: maxSide, fit: 'inside', kernel: 'lanczos3' });
    if (isJpeg(fullPath)) p = p.flatten({ background: '#ffffff' });
    const out = await encode(p, fullPath, quality).toBuffer();
    fs.writeFileSync(fullPath, out);
  } catch (_) { /* best effort */ }
}

async function metadata(fullPath) {
  if (!sharp) return null;
  try { return await sharp(fs.readFileSync(fullPath)).metadata(); } catch (_) { return null; }
}

/** Returns true if the buffer decodes as an image (Pillow's Image.verify()). */
async function isValidImage(buf) {
  if (!sharp) return true;
  try {
    const m = await sharp(buf).metadata();
    return !!(m && m.width && m.height);
  } catch (_) { return false; }
}

module.exports = { sharp, resizeIfWider, resizeIfLarger, metadata, isValidImage, isJpeg, encode };
