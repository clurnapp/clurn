# Cria o atalho "Clurn" na área de trabalho e no Menu Iniciar: dois cliques abrem o app numa janela própria, sem terminal.
# Uso: powershell -ExecutionPolicy Bypass -File scripts\windows\criar-atalho.ps1
# Com o app empacotado (npm run empacotar), copia dist\Clurn-win32-x64 para %LOCALAPPDATA%\Programs\Clurn e abre
# o Clurn.exe de lá: nome e ícone do Clurn na pasta, na barra de tarefas e no Gerenciador de Tarefas (pedido do autor,
# 30/10). Depois de empacotar de novo, rode este script outra vez para atualizar a cópia.
# Sem pacote, com o Electron instalado (npm install), abre o app de desktop (desktop/main.ts) desta pasta.
# Sem nenhum dos dois, abre a janela do Edge (server.ts --janela). Em todos, só o servidor local (127.0.0.1) roda.
# Fechar a janela encerra o app e apaga as chaves da memória.

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$server = Join-Path $repo 'src\app\server.ts'
# Trocar o desenho do ícone? Use um NOME de arquivo novo: o Windows guarda o ícone em cache pelo caminho
# e continua mostrando o antigo mesmo com F5.
$icon = Join-Path $repo 'desktop\clurn-icone.ico'

# Ícone da barra de tarefas: o Windows acha o ícone pelo AppUserModelID da janela, procurando um atalho do
# Menu Iniciar com o mesmo ID. App de desktop: app.setAppUserModelId('Clurn') em desktop/main.ts.
# Janela do Edge (--app, perfil Clurn\janela em server.ts): se identifica com o ID abaixo e não traz ícone
# próprio, então sem isso o Windows esticava o favicon de 16 px (lido da janela aberta em 30/10/2026).
$packaged = Join-Path $repo 'dist\Clurn-win32-x64'
$installed = Join-Path $env:LOCALAPPDATA 'Programs\Clurn'
$electron = Join-Path $repo 'node_modules\electron\dist\electron.exe'
$workDir = $repo
if (Test-Path (Join-Path $packaged 'Clurn.exe')) {
  # cópia fora do repositório: o próximo "npm run empacotar" não esbarra no app aberto
  $running = Get-Process -Name Clurn -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$installed\*" }
  if ($running) { throw 'Feche o Clurn antes de atualizar a cópia instalada.' }
  # /XF unins*: o desinstalador do Clurn-Setup nessa pasta fica (o /MIR o apagaria como "extra")
  & robocopy $packaged $installed /MIR /XF unins* /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Falha ao copiar o app para $installed (robocopy $LASTEXITCODE)." }
  $target = Join-Path $installed 'Clurn.exe'
  $arguments = ''
  $windowStyle = 1
  $appId = 'Clurn'
  $icon = $target # o ícone vem de dentro do próprio Clurn.exe (win32 do empacotador)
  $workDir = $installed
} elseif (Test-Path $electron) {
  $target = $electron
  $arguments = '"' + $repo + '"'
  $windowStyle = 1
  $appId = 'Clurn'
} else {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw 'Node não encontrado. Instale o Node 24 (nodejs.org) e rode de novo.' }
  # aspas simples do PowerShell: o caminho vai literal, sem expandir nada
  $q = { param($s) "'" + ($s -replace "'", "''") + "'" }
  $command = "& $(& $q $node.Source) $(& $q $server) --janela"
  $target = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = "-NoProfile -WindowStyle Hidden -Command `"$command`""
  $windowStyle = 7
  $appId = 'MSEdge.127.0.0.1_/.janela.Default'
}

Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class ClurnLnk {
  [StructLayout(LayoutKind.Sequential, Pack = 4)] struct PROPERTYKEY { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit)] struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; [FieldOffset(16)] public long pad; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore { int GetCount(out uint c); int GetAt(uint i, out PROPERTYKEY k); int GetValue(ref PROPERTYKEY k, out PROPVARIANT v); int SetValue(ref PROPERTYKEY k, ref PROPVARIANT v); int Commit(); }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHGetPropertyStoreFromParsingName(string path, IntPtr bc, int flags, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore ps);
  public static void SetAppId(string lnk, string id) {
    var iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"); IPropertyStore ps;
    Marshal.ThrowExceptionForHR(SHGetPropertyStoreFromParsingName(lnk, IntPtr.Zero, 2 /* GPS_READWRITE */, ref iid, out ps));
    var key = new PROPERTYKEY { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 }; // System.AppUserModel.ID
    var v = new PROPVARIANT { vt = 31 /* VT_LPWSTR */, p = Marshal.StringToCoTaskMemUni(id) };
    try { Marshal.ThrowExceptionForHR(ps.SetValue(ref key, ref v)); Marshal.ThrowExceptionForHR(ps.Commit()); }
    finally { Marshal.FreeCoTaskMem(v.p); Marshal.ReleaseComObject(ps); }
  }
}
"@

$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $lnk = Join-Path $dir 'Clurn.lnk'
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = $target
  $s.Arguments = $arguments
  $s.WorkingDirectory = $workDir
  $s.IconLocation = "$icon,0"
  $s.Description = 'Clurn: limpeza das carteiras temporárias (roda só neste computador)'
  $s.WindowStyle = $windowStyle
  $s.Save()
  [ClurnLnk]::SetAppId($lnk, $appId)
  Write-Output "Atalho criado: $lnk"
}
Write-Output 'Se o ícone antigo continuar na barra de tarefas, feche o Clurn e abra de novo.'
