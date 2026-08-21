const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const repoRoot = path.resolve(__dirname, '..');
const assetsPath = path.join(repoRoot, 'assets');
const desktopSourceSvgPath = path.join(assetsPath, 'elvador-icon.svg');
const taskbarSourceSvgPath = path.join(assetsPath, 'elvador-logo.svg');
const desktopOutputPngPath = path.join(assetsPath, 'icon-512.png');
const desktopOutputIcoPath = path.join(assetsPath, 'icon.ico');
const taskbarOutputPngPath = path.join(assetsPath, 'taskbar-icon.png');
const taskbarOutputIcoPath = path.join(assetsPath, 'taskbar-icon.ico');
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

async function renderCroppedLogoPng(sourceSvgPath, size, zoom = 1.24) {
  const renderSize = Math.round(size * zoom);
  const cropOffset = Math.round((renderSize - size) / 2);
  return sharp(sourceSvgPath, { density: 384 })
    .resize(renderSize, renderSize, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .ensureAlpha()
    .extract({ left: cropOffset, top: cropOffset, width: size, height: size })
    .png()
    .toBuffer();
}

async function renderDesktopIconPng(size) {
  const badgeInset = Math.max(1, Math.round(size * 0.035));
  const badgeSize = size - (badgeInset * 2);
  const cornerRadius = Math.max(2, Math.round(badgeSize * 0.22));
  const badgeSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect x="${badgeInset}" y="${badgeInset}" width="${badgeSize}" height="${badgeSize}" rx="${cornerRadius}" fill="#ffffff"/></svg>`
  );
  const logoPng = await renderCroppedLogoPng(desktopSourceSvgPath, size);

  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([{ input: badgeSvg }, { input: logoPng }])
    .png()
    .toBuffer();
}

async function renderTaskbarIconPng(size) {
  // 2026-08-21: Windows taskbar and tray need the white ring mark with no tile
  // behind it; the desktop shortcut keeps the black-on-white version for contrast.
  return renderCroppedLogoPng(taskbarSourceSvgPath, size, 1.18);
}

async function writeIconSet({ outputPngPath, outputIcoPath, renderIcon }) {
  fs.writeFileSync(outputPngPath, await renderIcon(512));
  const icoImages = [];
  for (const size of iconSizes) {
    icoImages.push({ size, buffer: await renderIcon(size) });
  }
  fs.writeFileSync(outputIcoPath, createIcoBuffer(icoImages));
}

async function main() {
  await writeIconSet({
    outputPngPath: desktopOutputPngPath,
    outputIcoPath: desktopOutputIcoPath,
    renderIcon: renderDesktopIconPng
  });
  await writeIconSet({
    outputPngPath: taskbarOutputPngPath,
    outputIcoPath: taskbarOutputIcoPath,
    renderIcon: renderTaskbarIconPng
  });
  console.log(`Wrote ${path.relative(repoRoot, desktopOutputPngPath)}`);
  console.log(`Wrote ${path.relative(repoRoot, desktopOutputIcoPath)}`);
  console.log(`Wrote ${path.relative(repoRoot, taskbarOutputPngPath)}`);
  console.log(`Wrote ${path.relative(repoRoot, taskbarOutputIcoPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
