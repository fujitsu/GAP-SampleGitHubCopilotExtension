const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('1. Building extension...');
execSync('npm run compile', { stdio: 'inherit' });

console.log('2. Copying extension-landing.md to README.md...');
const landingPath = path.join(__dirname, '../extension-landing.md');
const readmePath = path.join(__dirname, '../README.md');
fs.copyFileSync(landingPath, readmePath);
console.log('extension-landing.md copied to README.md successfully.');

console.log('3. Removing src/ directory for clean packaging...');
const srcDir = path.join(__dirname, '../src');
if (fs.existsSync(srcDir)) {
  fs.rmSync(srcDir, { recursive: true, force: true });
  console.log('src/ directory removed successfully.');
}