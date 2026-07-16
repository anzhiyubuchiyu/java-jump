const fs = require('fs');
const path = require('path');

const workspace = path.resolve(__dirname, '..');
const { name, version } = require(path.join(workspace, 'package.json'));
const currentArtifact = `${name}-${version}.vsix`;

for (const entry of fs.readdirSync(workspace, { withFileTypes: true })) {
  if (!entry.isFile() || !new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-.*\\.vsix$`).test(entry.name)) {
    continue;
  }
  if (entry.name !== currentArtifact) {
    fs.unlinkSync(path.join(workspace, entry.name));
  }
}
