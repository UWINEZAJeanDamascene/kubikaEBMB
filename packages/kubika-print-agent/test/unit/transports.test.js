const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { printPdfWindows } = require('../../src/transports');

test('A4 printing sends tray, duplex, paper, and copy settings to Sumatra without a shell', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kubika-sumatra-print-'));
  const executable = path.join(directory, 'SumatraPDF.exe');
  fs.writeFileSync(executable, 'test executable');
  const calls = [];

  try {
    await printPdfWindows('Office Printer', Buffer.from('%PDF-test'), 2, {
      tray: 'Tray 2',
      duplex: true,
      sumatraPdfPath: executable,
      tempDirectory: directory,
      spawnProcess: (file, args, options) => {
        const child = new EventEmitter();
        child.stderr = new PassThrough();
        calls.push({ file, args, options, child });
        setImmediate(() => child.emit('close', 0, null));
        return child;
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, executable);
    assert.deepEqual(calls[0].args.slice(0, 5), [
      '-print-to',
      'Office Printer',
      '-print-settings',
      'shrink,paper=A4,ignore-pdf-print-settings,bin=Tray 2,duplexlong,2x',
      '-silent',
    ]);
    assert.equal(fs.existsSync(calls[0].args[5]), false);
    assert.deepEqual(calls[0].options, { windowsHide: true });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('A4 simplex explicitly overrides duplex defaults and rejects tray-setting injection', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kubika-sumatra-print-'));
  const executable = path.join(directory, 'SumatraPDF.exe');
  fs.writeFileSync(executable, 'test executable');
  let settingsArgument = '';

  try {
    await printPdfWindows('Office Printer', Buffer.from('%PDF-test'), 1, {
      tray: 'Letter Tray',
      duplex: false,
      sumatraPdfPath: executable,
      tempDirectory: directory,
      spawnProcess: (_file, args) => {
        const child = new EventEmitter();
        child.stderr = new PassThrough();
        settingsArgument = args[3];
        setImmediate(() => child.emit('close', 0, null));
        return child;
      },
    });
    assert.equal(settingsArgument, 'shrink,paper=A4,ignore-pdf-print-settings,bin=Letter Tray,simplex,1x');

    await assert.rejects(printPdfWindows('Office Printer', Buffer.from('%PDF-test'), 1, {
      tray: 'Tray 1,output=C:\\unexpected.pdf',
      duplex: true,
      sumatraPdfPath: executable,
      tempDirectory: directory,
      spawnProcess: () => { throw new Error('must not launch on invalid settings'); },
    }), { code: 'PRINT_A4_TRAY_INVALID' });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('A4 per-job settings fail clearly when SumatraPDF is unavailable', async () => {
  await assert.rejects(printPdfWindows('Office Printer', Buffer.from('%PDF-test'), 1, {
    tray: 'Tray 2',
    duplex: false,
    sumatraPdfPath: null,
  }), { code: 'PRINT_A4_OPTIONS_RUNTIME_MISSING' });
});
