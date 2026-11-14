const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

function printPdfWindows(printerName, pdfBuffer, copies = 1) {
  return new Promise((resolve, reject) => {
    const tempFile = path.join(os.tmpdir(), `kubika-${process.pid}-${Date.now()}.pdf`);
    fs.writeFileSync(tempFile, pdfBuffer);
    const printerArg = printerName ? ` -printerName '${String(printerName).replace(/'/g, "''")}'` : '';
    const script = `$shell=New-Object -ComObject Shell.Application; $item=$shell.NameSpace((Split-Path -Parent '${tempFile.replace(/'/g, "''")}')).ParseName((Split-Path -Leaf '${tempFile.replace(/'/g, "''")}')); $verb=$item.Verbs() | Where-Object {$_.Name -match 'print'}; if($verb){$verb.DoIt(); Start-Sleep -Seconds 2}else{throw 'No Windows print verb for PDF'}${printerArg}`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => { fs.unlinkSync(tempFile); reject(error); });
    child.on('close', (code) => {
      fs.unlinkSync(tempFile);
      code === 0 ? resolve() : reject(new Error(stderr.trim() || `PDF print failed with code ${code}`));
    });
  });
}

module.exports = { printTcp9100, printWindowsSpoolerRaw, printPdfWindows };
