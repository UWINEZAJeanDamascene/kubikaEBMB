const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function dpapiProtect(value, dir) {
  if (process.platform !== 'win32') {
    const key = crypto.createHash('sha256').update(`${os.hostname()}:${dir}`).digest();
    const iv = Buffer.alloc(16, 0);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([cipher.update(Buffer.from(value, 'utf8')), cipher.final()]).toString('base64');
  }
  const ps = [
    'Add-Type -AssemblyName System.Security;',
    '$text = [Console]::In.ReadToEnd();',
    '$bytes = [Text.Encoding]::UTF8.GetBytes($text);',
    '$protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine);',
    '[Convert]::ToBase64String($protected)',
  ].join(' ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    input: value,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || !String(result.stdout).trim()) throw new Error('Machine-scope DPAPI protection failed.');
  return String(result.stdout).trim();
}

function dpapiUnprotect(value, dir) {
  if (process.platform !== 'win32') {
    const key = crypto.createHash('sha256').update(`${os.hostname()}:${dir}`).digest();
    const iv = Buffer.alloc(16, 0);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([decipher.update(Buffer.from(value, 'base64')), decipher.final()]).toString('utf8');
  }
  const ps = [
    'Add-Type -AssemblyName System.Security;',
    '$text = [Console]::In.ReadToEnd();',
    '$bytes = [Convert]::FromBase64String($text);',
    '$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine);',
    '[Text.Encoding]::UTF8.GetString($plain)',
  ].join(' ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    input: value,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error('Machine-scope DPAPI unprotect failed.');
  return String(result.stdout);
}

class CredentialStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'credentials.dpapi');
  }

  save(credentials) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.file, dpapiProtect(JSON.stringify(credentials), this.dataDir), { mode: 0o600 });
  }

  load() {
    if (!fs.existsSync(this.file)) return null;
    return JSON.parse(dpapiUnprotect(fs.readFileSync(this.file, 'utf8').trim(), this.dataDir));
  }

  clear() {
    if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
  }
}

module.exports = { CredentialStore, dpapiProtect, dpapiUnprotect };
