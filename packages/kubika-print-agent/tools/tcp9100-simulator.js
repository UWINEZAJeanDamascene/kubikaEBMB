const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const args = process.argv.slice(2);
const valueAfter = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const host = valueAfter('--host', '127.0.0.1');
const port = Number(valueAfter('--port', '9100'));
const outputDir = path.resolve(valueAfter('--output', path.join(__dirname, '..', 'captures')));

fs.mkdirSync(outputDir, { recursive: true });

const server = net.createServer((socket) => {
  const chunks = [];
  socket.on('data', (chunk) => chunks.push(chunk));
  socket.on('end', () => {
    const receipt = Buffer.concat(chunks);
    if (!receipt.length) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `print-${timestamp}-${process.pid}.bin`;
    const capturePath = path.join(outputDir, filename);
    fs.writeFileSync(capturePath, receipt);
    console.log(`[TCP9100] Captured ${receipt.length} bytes: ${capturePath}`);
  });
});

server.on('error', (error) => {
  console.error(`[TCP9100] ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`[TCP9100] Virtual thermal printer listening at ${host}:${port}`);
  console.log(`[TCP9100] Captures are saved in ${outputDir}`);
});
