'use strict';
const zlib = require('node:zlib');

// Minimal PNG reader: IHDR + first scanline pixels (8-bit RGB/RGBA, non-interlaced).
function readPng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let pos = 8;
  let ihdr = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        bitDepth: data[8], colorType: data[9], interlace: data[12],
      };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  return { ...ihdr, idat: Buffer.concat(idat) };
}

// Returns [r,g,b,a] of pixel (x, 0) of the first scanline (first row: filters 0-4 reduce to simple cases).
function firstRowPixel(png, x) {
  const bpp = png.colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(png.idat);
  const filter = raw[0];
  const row = Buffer.from(raw.subarray(1, 1 + png.width * bpp));
  // On the first row the "up" neighbour is 0: Up = None, Average = floor(left/2), Paeth = Sub.
  for (let i = 0; i < row.length; i++) {
    const left = i >= bpp ? row[i - bpp] : 0;
    if (filter === 1 || filter === 4) row[i] = (row[i] + left) & 255;
    else if (filter === 3) row[i] = (row[i] + (left >> 1)) & 255;
    else if (filter > 4) throw new Error('bad png filter ' + filter);
  }
  const o = x * bpp;
  return [row[o], row[o + 1], row[o + 2], bpp === 4 ? row[o + 3] : 255];
}

module.exports = { readPng, firstRowPixel };
