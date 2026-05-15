// Re-render imgs/demo-thumbnail.png from the YouTube CDN thumbnail.
// Run once sharp is available locally:
//   npm install --no-save sharp
//   node scripts/make-thumbnail.js
// Swap SOURCE_URL to maxresdefault.jpg once YouTube generates it.
const fs = require('fs');
const path = require('path');
const https = require('https');
const sharp = require('sharp');

const VIDEO_ID = 'LE-sSiiLw6I';
const SOURCE_URL = `https://img.youtube.com/vi/${VIDEO_ID}/hqdefault.jpg`;
const OUT = path.join(__dirname, '..', 'imgs', 'demo-thumbnail.png');

// hqdefault.jpg is 480x360 with the 16:9 video letterboxed inside a 4:3 frame.
// The visible 16:9 area is the center 480x270 (45px bars top and bottom).
const CROP = { left: 0, top: 45, width: 480, height: 270 };
const RADIUS = 18;

function download(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

(async () => {
  const buf = await download(SOURCE_URL);

  const { width, height } = CROP;
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${RADIUS}" ry="${RADIUS}" fill="white"/></svg>`
  );

  await sharp(buf)
    .extract(CROP)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toFile(OUT);

  const stat = fs.statSync(OUT);
  console.log(`wrote ${OUT} (${stat.size} bytes, ${width}x${height}, r=${RADIUS})`);
})();
