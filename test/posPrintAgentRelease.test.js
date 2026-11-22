const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const releaseDirectory = path.join(__dirname, '..', 'downloads', 'print-agent');
const manifest = JSON.parse(fs.readFileSync(path.join(releaseDirectory, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
const agentPackage = require('../packages/kubika-print-agent/package.json');

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

describe('tracked Print Agent release', () => {
  test('matches the source package version and includes integrity-checked installer assets', async () => {
    expect(manifest.version).toBe(agentPackage.version);
    expect(manifest.setup).toBe(`KubikaPrintAgent-${manifest.version}-setup.exe`);
    expect(manifest.package).toBe(`KubikaPrintAgent-${manifest.version}-portable.zip`);

    const artifacts = [
      [manifest.setup, manifest.setupSha256],
      [manifest.package, manifest.packageSha256],
    ];

    for (const [filename, expectedHash] of artifacts) {
      const artifactPath = path.join(releaseDirectory, filename);
      expect(fs.existsSync(artifactPath)).toBe(true);
      expect(expectedHash).toMatch(/^[a-f\d]{64}$/i);
      expect(await sha256(artifactPath)).toBe(expectedHash);
    }

    expect(manifest.sha256).toBe(manifest.packageSha256);
    expect(fs.existsSync(path.join(releaseDirectory, manifest.releaseNotes))).toBe(true);
  });
});
