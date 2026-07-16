const fs = require('fs');
const path = require('path');

const workspace = path.resolve(__dirname, '..');
const outputDirectory = path.resolve(workspace, 'out');

if (path.relative(workspace, outputDirectory) !== 'out') {
  throw new Error(`Refusing to clean an unexpected output directory: ${outputDirectory}`);
}

fs.rmSync(outputDirectory, { recursive: true, force: true });
