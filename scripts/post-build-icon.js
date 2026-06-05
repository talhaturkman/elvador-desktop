const { rcedit } = require('rcedit');
const path = require('path');

async function main() {
  const exePath = path.resolve(__dirname, '..', 'release', 'win-unpacked', 'Elvador.exe');
  const icoPath = path.resolve(__dirname, '..', 'assets', 'icon.ico');

  await rcedit(exePath, { icon: icoPath });
  console.log('Icon embedded into Elvador.exe');
}

main().catch(e => { console.error(e); process.exit(1); });
