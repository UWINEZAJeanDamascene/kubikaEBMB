#define AppName "Kubika Print Agent"
#define AppVersion "0.1.2"
#define AppPublisher "Kubika"
#define AppExeName "service.exe"

[Setup]
AppId={{C6C1A19A-6E4D-4CF0-A1D2-0B86A4A6A7C5}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\Kubika\PrintAgent
DefaultGroupName=Kubika
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\release
OutputBaseFilename=KubikaPrintAgent-{#AppVersion}-setup
Compression=lzma2/ultra64
SolidCompression=yes
UninstallDisplayIcon={app}\service.exe
ChangesEnvironment=no

[Files]
Source: "..\staging\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{commonprograms}\Kubika\Kubika Print Agent Setup"; Filename: "{app}\open-setup.cmd"; WorkingDir: "{app}"
Name: "{commondesktop}\Kubika Print Agent Setup"; Filename: "{app}\open-setup.cmd"; WorkingDir: "{app}"

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install.ps1"" ""{app}"""; Flags: runhidden waituntilterminated; StatusMsg: "Installing Kubika Print Agent service..."
Filename: "{app}\open-setup.cmd"; Description: "Open Kubika Print Agent setup page"; Flags: postinstall shellexec skipifsilent

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\uninstall.ps1"" ""{app}"""; RunOnceId: "KubikaPrintAgentUninstall"; Flags: runhidden waituntilterminated

[Code]
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    if MsgBox('Delete the paired credentials, printer configuration, and print history from this shop computer?', mbConfirmation, MB_YESNO) = IDYES then
    begin
      Exec('cmd.exe', '/C rmdir /S /Q "%ProgramData%\Kubika\PrintAgent"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    end;
  end;
end;
