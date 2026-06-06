const { rcedit } = require('rcedit');
const fs = require('fs');
const path = require('path');

async function main() {
  const releasePath = path.resolve(__dirname, '..', 'release');
  const unpackedDir = ['win-ia32-unpacked', 'win-unpacked']
    .map((dirName) => path.join(releasePath, dirName))
    .find((dirPath) => fs.existsSync(dirPath));

  if (!unpackedDir) {
    throw new Error('Missing unpacked Windows build directory');
  }

  const exePath = fs.readdirSync(unpackedDir)
    .filter((fileName) => fileName.toLowerCase().endsWith('.exe'))
    .map((fileName) => path.join(unpackedDir, fileName))[0];

  if (!exePath) {
    throw new Error(`Missing executable in ${unpackedDir}`);
  }

  const icoPath = path.resolve(__dirname, '..', 'assets', 'icon.ico');

  await rcedit(exePath, { icon: icoPath });
  console.log(`Icon embedded into ${path.basename(exePath)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
