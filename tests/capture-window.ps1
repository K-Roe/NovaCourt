param([string]$OutputPath, [int]$X, [int]$Y, [int]$Width, [int]$Height)
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap($Width, $Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  Start-Sleep -Milliseconds 350
  $graphics.CopyFromScreen($X, $Y, 0, 0, $bitmap.Size)
  $bitmap.Save($OutputPath)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
