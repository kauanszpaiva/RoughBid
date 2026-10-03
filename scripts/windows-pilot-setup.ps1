[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ConfigPath, [string]$CredentialsFile)
$ErrorActionPreference = 'Stop'
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
Write-Host 'RoughBid: configuração local protegida.'
Write-Host 'Verificação: schema Supabase e metadados Gemini. Sem inferência, uploads ou testes pagos.'
$serviceSecure = $null
$geminiSecure = $null
if (!$CredentialsFile) {
    $serviceSecure = Read-Host 'Supabase RoughBid - SUPABASE_SERVICE_ROLE_KEY (service_role/secret)' -AsSecureString
    $geminiSecure = Read-Host 'Google AI Studio - GEMINI_API_KEY' -AsSecureString
} else {
    $CredentialsFile = [IO.Path]::GetFullPath($CredentialsFile)
    if (!$config.credentialsFile -or $CredentialsFile -ne [IO.Path]::GetFullPath($config.credentialsFile)) { throw 'Arquivo de entrada diferente do caminho protegido configurado.' }
}
$servicePointer = [IntPtr]::Zero
$geminiPointer = [IntPtr]::Zero
try {
    $payload = ''
    if (!$CredentialsFile) {
        $servicePointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($serviceSecure)
        $geminiPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($geminiSecure)
        $payload = @{
            supabaseServiceRoleKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($servicePointer)
            geminiApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($geminiPointer)
        } | ConvertTo-Json -Compress
    }
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $config.nodePath
    $startInfo.Arguments = '"{0}" "{1}"' -f (Join-Path $config.repository 'scripts\windows-pilot-configure.mjs'), $ConfigPath
    if ($CredentialsFile) { $startInfo.Arguments += ' --credentials-file "{0}"' -f $CredentialsFile }
    $startInfo.WorkingDirectory = $config.repository
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $process.StandardInput.Write($payload)
    $process.StandardInput.Close()
    $payload = $null
    $safeOutput = $process.StandardOutput.ReadToEnd()
    $safeError = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($safeOutput) { Write-Output $safeOutput.Trim() }
    if ($safeError) { Write-Output $safeError.Trim() }
    if ($process.ExitCode -ne 0) { throw 'A validação falhou. O worker continua pausado; nenhuma chave foi exibida.' }
    Write-Host 'Credenciais verificadas e salvas somente na configuração local protegida.'
} finally {
    if ($servicePointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($servicePointer) }
    if ($geminiPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($geminiPointer) }
    if ($serviceSecure) { $serviceSecure.Dispose() }
    if ($geminiSecure) { $geminiSecure.Dispose() }
    $payload = $null
}
