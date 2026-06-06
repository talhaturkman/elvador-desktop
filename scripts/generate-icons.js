const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const repoRoot = path.resolve(__dirname, '..');
const assetsPath = path.join(repoRoot, 'assets');
const sourceSvgPath = path.join(assetsPath, 'elvador-icon.svg');
const outputPngPath = path.join(assetsPath, 'icon-512.png');
const outputIcoPath = path.join(assetsPath, 'icon.ico');
const iconSizes = [16, 24, 32, 48, 64, 128, 256];

function createIcoBuffer(images) {
  const headerSize = 6;
  const directoryEntrySize = 16;
  const directorySize = headerSize + (directoryEntrySize * images.length);
  const totalSize = directorySize + images.reduce((sum, image) => sum + image.buffer.length, 0);
  const icoBuffer = Buffer.alloc(totalSize);

  icoBuffer.writeUInt16LE(0, 0);
  icoBuffer.writeUInt16LE(1, 2);
  icoBuffer.writeUInt16LE(images.length, 4);

  let imageOffset = directorySize;
  images.forEach((image, index) => {
    const entryOffset = headerSize + (index * directoryEntrySize);
    icoBuffer.writeUInt8(image.size >= 256 ? 0 : image.size, entryOffset);
    icoBuffer.writeUInt8(image.size >= 256 ? 0 : image.size, entryOffset + 1);
    icoBuffer.writeUInt8(0, entryOffset + 2);
    icoBuffer.writeUInt8(0, entryOffset + 3);
    icoBuffer.writeUInt16LE(1, entryOffset + 4);
    icoBuffer.writeUInt16LE(32, entryOffset + 6);
    icoBuffer.writeUInt32LE(image.buffer.length, entryOffset + 8);
    icoBuffer.writeUInt32LE(imageOffset, entryOffset + 12);
    image.buffer.copy(icoBuffer, imageOffset);
    imageOffset += image.buffer.length;
  });

  return icoBuffer;
}

async function renderIconPng(size) {
  return sharp(sourceSvgPath, { density: 384 })
    .resize(size, size, {
      fit: 'contain',
      background: '#000000'
    })
    .png()
    .toBuffer();
}

async function main() {
  const png512 = await renderIconPng(512);
  fs.writeFileSync(outputPngPath, png512);

  const icoImages = [];
  for (const size of iconSizes) {
    icoImages.push({
      size,
      buffer: await renderIconPng(size)
    });
  }

  fs.writeFileSync(outputIcoPath, createIcoBuffer(icoImages));
  console.log(`Wrote ${path.relative(repoRoot, outputPngPath)}`);
  console.log(`Wrote ${path.relative(repoRoot, outputIcoPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
