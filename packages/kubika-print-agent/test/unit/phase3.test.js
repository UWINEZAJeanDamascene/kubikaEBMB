const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');

test('WinSW service uses LocalSystem and machine data directory', () => {
  const xml = fs.readFileSync(path.join(root, 'service/winsw.xml'), 'utf8');
  assert.match(xml, /<id>KubikaPrintAgent<\/id>/);
  assert.match(xml, /<user>LocalSystem<\/user>/);
  assert.match(xml, /ProgramData%>\\Kubika\\PrintAgent|ProgramData/);
  assert.match(xml, /runtime\\node\.exe|runtime\/node\.exe/);
  assert.match(xml, /<arguments>"%BASE%\\src\\main\.js"<\/arguments>/);
  assert.match(xml, /<env name="KUBIKA_BACKEND_URL" value="https:\/\/kubikapos\.up\.railway\.app"\/>/);
});

test('agent config defaults to hosted API in production and localhost in development', () => {
  const configSource = fs.readFileSync(path.join(root, 'src/config.js'), 'utf8');
  assert.match(configSource, /process\.env\.NODE_ENV === 'production'[\s\S]*?'https:\/\/kubikapos\.up\.railway\.app'[\s\S]*?'http:\/\/127\.0\.0\.1:3000'/);
});

test('installer scripts provide install, uninstall, and setup shortcuts', () => {
  for (const relative of [
    'installer/setup.iss',
    'installer/build.ps1',
    'service/install.ps1',
    'service/uninstall.ps1',
    'service/open-setup.cmd',
  ]) {
    assert.equal(fs.existsSync(path.join(root, relative)), true, relative);
  }
  const install = fs.readFileSync(path.join(root, 'service/install.ps1'), 'utf8');
  assert.match(install, /existing.*Get-Service|Get-Service.*existing/i);
  assert.match(install, /serviceExe stop|serviceExe start/);
});

test('portable package staging includes the service config and lifecycle scripts', () => {
  const build = fs.readFileSync(path.join(root, 'installer/build.ps1'), 'utf8');
  assert.match(build, /service\\winsw\.xml.*staging.*service\.xml/i);
  assert.match(build, /service\\install\.ps1/);
  assert.match(build, /service\\uninstall\.ps1/);
  assert.match(build, /service\\open-setup\.cmd/);
});

test('Inno installer is per-machine and asks before deleting data', () => {
  const iss = fs.readFileSync(path.join(root, 'installer/setup.iss'), 'utf8');
  assert.match(iss, /PrivilegesRequired=admin/);
  assert.match(iss, /ArchitecturesInstallIn64BitMode=x64compatible/);
  assert.match(iss, /Delete the paired credentials/);
  assert.match(iss, /open-setup\.cmd/);
  assert.match(iss, /Source: "\.\.\\staging\\\*"/);
});
