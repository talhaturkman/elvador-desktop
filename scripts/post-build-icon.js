const { rcedit } = require('rcedit');
const path = require('path');

async function main() {
  const dir = process.argv[2] || 'win-unpacked';
  const exePath = path.resolve(__dirname, '..', 'release', dir, 'Elvador.exe');
  const icoPath = path.resolve(__dirname, '..', 'assets', 'icon.ico');

  await rcedit(exePath, { icon: icoPath });
  console.log(`Icon embedded into ${dir}/Elvador.exe`);
}

main().catch(e => { console.error(e); process.exit(1); });
