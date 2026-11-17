const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');

function printTcp9100(address, bytes, timeoutMs = 5000) {
  const match = /^([^:]+):(\d+)$/i.exec(String(address));
  if (!match) return Promise.reject(new Error('TCP printer address must be host:port.'));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: match[1], port: Number(match[2]) });
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      socket.destroy();
      reject(new Error('TCP printer connection timed out.'));
    }, timeoutMs);
    socket.on('connect', () => socket.end(bytes));
    socket.on('close', () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve();
    });
    socket.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function printWindowsSpoolerRaw(printerName, bytes) {
  return new Promise((resolve, reject) => {
    const tempFile = path.join(os.tmpdir(), `kubika-${process.pid}-${Date.now()}.bin`);
    fs.writeFileSync(tempFile, bytes);
    const psScript = `$printer = '${String(printerName).replace(/'/g, "''")}'; $file = '${tempFile.replace(/'/g, "''")}'; ` +
      '$spool = Add-Type -PassThru -MemberDefinition \'[DllImport("winspool.drv", SetLastError=true)] public static extern bool OpenPrinter(string pPrinterName, out IntPtr hPrinter, IntPtr pDefault); [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr hPrinter); [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] ref DOC_INFO_1 pDocInfo); [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr hPrinter); [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr hPrinter); [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr hPrinter); [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBuf, int cbBuf, out int pcWritten); public struct DOC_INFO_1 { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName; [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype; }\' -Name KubikaRawSpooler -Namespace Kubika; ' +
      '$h=[IntPtr]::Zero; if(-not [Kubika.KubikaRawSpooler]::OpenPrinter($printer,[ref]$h,[IntPtr]::Zero)){throw "OpenPrinter failed"} try {$doc=[Kubika.KubikaRawSpooler+DOC_INFO_1]::new();$doc.pDocName="Kubika Print Job";$doc.pOutputFile=$null;$doc.pDatatype="RAW";if(-not [Kubika.KubikaRawSpooler]::StartDocPrinter($h,1,[ref]$doc)){throw "StartDocPrinter failed"};$data=[IO.File]::ReadAllBytes($file);$written=0;if(-not [Kubika.KubikaRawSpooler]::StartPagePrinter($h)){throw "StartPagePrinter failed"};if(-not [Kubika.KubikaRawSpooler]::WritePrinter($h,$data,$data.Length,[ref]$written)){throw "WritePrinter failed"};$null=[Kubika.KubikaRawSpooler]::EndPagePrinter($h);$null=[Kubika.KubikaRawSpooler]::EndDocPrinter($h)} finally {$null=[Kubika.KubikaRawSpooler]::ClosePrinter($h)}';
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => { fs.unlinkSync(tempFile); reject(error); });
    child.on('close', (code) => {
      fs.unlinkSync(tempFile);
      code === 0 ? resolve() : reject(new Error(stderr.trim() || `Windows spooler failed with code ${code}`));
    });
  });
}

function findSumatraPdfPath() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const candidates = [
    process.env.KUBIKA_SUMATRA_PDF_PATH,
    path.join(__dirname, '..', 'tools', 'SumatraPDF.exe'),
    path.join(path.dirname(process.execPath), 'SumatraPDF.exe'),
    path.join(programFiles, 'SumatraPDF', 'SumatraPDF.exe'),
    path.join(programFilesX86, 'SumatraPDF', 'SumatraPDF.exe'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'SumatraPDF', 'SumatraPDF.exe') : null,
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function printPdfWithSumatra(printerName, pdfBuffer, copies, options) {
  const sumatraPath = options.sumatraPdfPath === null
    ? null
    : options.sumatraPdfPath || findSumatraPdfPath();
  if (!sumatraPath) {
    return Promise.reject(Object.assign(
      new Error('Install SumatraPDF or set KUBIKA_SUMATRA_PDF_PATH to apply A4 tray or duplex settings.'),
      { code: 'PRINT_A4_OPTIONS_RUNTIME_MISSING' },
    ));
  }
  const tray = options.tray == null ? null : String(options.tray).trim();
  if (tray && (tray.length > 80 || /[\u0000-\u001f\u007f,=]/.test(tray))) {
    return Promise.reject(Object.assign(new Error('The A4 printer tray name contains unsupported characters.'), {
      code: 'PRINT_A4_TRAY_INVALID',
    }));
  }
  if (options.duplex !== undefined && typeof options.duplex !== 'boolean') {
    return Promise.reject(Object.assign(new Error('The A4 duplex setting must be true or false.'), {
      code: 'PRINT_A4_DUPLEX_INVALID',
    }));
  }
  const settings = ['shrink', 'paper=A4', 'ignore-pdf-print-settings'];
  if (tray) settings.push(`bin=${tray}`);
  if (options.duplex === true) settings.push('duplexlong');
  if (options.duplex === false) settings.push('simplex');
  settings.push(`${copies}x`);

  const tempDirectory = options.tempDirectory || os.tmpdir();
  const tempFile = path.join(tempDirectory, `kubika-${process.pid}-${randomUUID()}.pdf`);
  fs.writeFileSync(tempFile, pdfBuffer);
  const spawnProcess = options.spawnProcess || spawn;
  return new Promise((resolve, reject) => {
    let stderr = '';
    const cleanup = () => {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    };
    let child;
    try {
      child = spawnProcess(sumatraPath, [
        '-print-to',
        printerName,
        '-print-settings',
        settings.join(','),
        '-silent',
        tempFile,
      ], { windowsHide: true });
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      cleanup();
      reject(Object.assign(new Error(`SumatraPDF could not start: ${error.message}`), {
        code: 'PRINT_A4_RUNTIME_LAUNCH_FAILED',
        cause: error,
      }));
    });
    child.on('close', (code) => {
      cleanup();
      if (code === 0) resolve();
      else reject(Object.assign(
        new Error(stderr.trim() || `SumatraPDF printing failed with exit code ${code}.`),
        { code: 'PRINT_A4_TRANSMIT_FAILED' },
      ));
    });
  });
}

function printPdfWindows(printerName, pdfBuffer, copies = 1, options = {}) {
  const printer = String(printerName || '').trim();
  const copyCount = Number(copies);
  if (!printer || !Number.isInteger(copyCount) || copyCount < 1 || copyCount > 10) {
    return Promise.reject(new Error('A named Windows printer and 1 to 10 copies are required for PDF printing.'));
  }
  if (Object.hasOwn(options, 'tray') || Object.hasOwn(options, 'duplex')) {
    return printPdfWithSumatra(printer, pdfBuffer, copyCount, options);
  }
  return new Promise((resolve, reject) => {
    const tempFile = path.join(os.tmpdir(), `kubika-${process.pid}-${Date.now()}.pdf`);
    fs.writeFileSync(tempFile, pdfBuffer);
    const file = tempFile.replace(/'/g, "''");
    const targetPrinter = printer.replace(/'/g, "''");
    const script = `$file='${file}';$printer='${targetPrinter}';for($copy=0;$copy -lt ${copyCount};$copy++){Start-Process -FilePath $file -Verb PrintTo -ArgumentList ('"' + $printer + '"') -Wait -ErrorAction Stop}`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      reject(error);
    });
    child.on('close', (code) => {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      code === 0 ? resolve() : reject(new Error(stderr.trim() || `PDF print failed with code ${code}`));
    });
  });
}

module.exports = { findSumatraPdfPath, printTcp9100, printWindowsSpoolerRaw, printPdfWindows };
