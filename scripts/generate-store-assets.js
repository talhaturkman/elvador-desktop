const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const projectRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(projectRoot, 'assets', 'icon-512.png');
const outputDirectory = path.join(projectRoot, 'build', 'appx');
const white = { r: 255, g: 255, b: 255, alpha: 1 };

async function main() {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Store icon source not found: ${sourcePath}`);
  }

  fs.mkdirSync(outputDirectory, { recursive: true });

  for (const [fileName, size] of [
    ['StoreLogo.png', 50],
    ['Square150x150Logo.png', 150],
    ['Square44x44Logo.png', 44]
  ]) {
    await sharp(sourcePath)
      .resize(size, size, { fit: 'contain', background: white })
      .png()
      .toFile(path.join(outputDirectory, fileName));
  }

  const squareLogo = await sharp(sourcePath)
    .resize(150, 150, { fit: 'contain', background: white })
    .png()
    .toBuffer();

  await sharp({
    create: { width: 310, height: 150, channels: 4, background: white }
  })
    .composite([{ input: squareLogo, left: 80, top: 0 }])
    .png()
    .toFile(path.join(outputDirectory, 'Wide310x150Logo.png'));
}

main().catch((error) => {
  console.error(`Store icon generation failed: ${error.message}`);
  process.exitCode = 1;
});
