# Gera ícones e telas de abertura (web, Android e iOS) a partir de www/assets/logo.png.
# Uso: powershell -ExecutionPolicy Bypass -File scripts/gen-icons.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$logo = [System.Drawing.Image]::FromFile((Join-Path $root 'www\assets\logo.png'))

function New-Canvas([int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'HighQuality'; $g.PixelOffsetMode = 'HighQuality'
  return @($bmp, $g)
}

function Fill-Wallpaper($g, [int]$w, [int]$h) {
  # Gradiente azul Aero, igual ao fundo do app
  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(10, 99, 201)), ([System.Drawing.Color]::FromArgb(11, 79, 163)), 60
  $blend = New-Object System.Drawing.Drawing2D.ColorBlend 3
  $blend.Colors = @([System.Drawing.Color]::FromArgb(10, 99, 201), [System.Drawing.Color]::FromArgb(71, 182, 240), [System.Drawing.Color]::FromArgb(11, 79, 163))
  $blend.Positions = @(0.0, 0.55, 1.0)
  $brush.InterpolationColors = $blend
  $g.FillRectangle($brush, $rect)
  $brush.Dispose()
}

function Save-Logo([string]$path, [int]$size, [double]$scale, [bool]$background) {
  $bmp, $g = New-Canvas $size $size
  if ($background) { Fill-Wallpaper $g $size $size } else { $g.Clear([System.Drawing.Color]::Transparent) }
  $s = [int]($size * $scale); $o = [int](($size - $s) / 2)
  $g.DrawImage($logo, $o, $o, $s, $s)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

function Save-Splash([string]$path) {
  $old = [System.Drawing.Image]::FromFile($path); $w = $old.Width; $h = $old.Height; $old.Dispose()
  $bmp, $g = New-Canvas $w $h
  Fill-Wallpaper $g $w $h
  $s = [int]([Math]::Min($w, $h) * 0.32); $g.DrawImage($logo, [int](($w - $s) / 2), [int](($h - $s) / 2), $s, $s)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

# Web: favicon, ícones do manifesto e da interface
$web = Join-Path $root 'www\assets'
foreach ($px in 64, 192, 512) { Save-Logo (Join-Path $web "icon-$px.png") $px 1.0 $false }

# Android: ícone tradicional, redondo e adaptativo, todos com fundo transparente
# (a cor de fundo do adaptativo fica em res/values/ic_launcher_background.xml)
$res = Join-Path $root 'android\app\src\main\res'
$densities = @{ 'mdpi' = 48; 'hdpi' = 72; 'xhdpi' = 96; 'xxhdpi' = 144; 'xxxhdpi' = 192 }
foreach ($d in $densities.Keys) {
  $px = $densities[$d]
  Save-Logo (Join-Path $res "mipmap-$d\ic_launcher.png") $px 1.0 $false
  Save-Logo (Join-Path $res "mipmap-$d\ic_launcher_round.png") $px 1.0 $false
  # 0.48: as pontas do logo ficam a até 34dp do centro, dentro da máscara redonda (36dp de raio)
  Save-Logo (Join-Path $res "mipmap-$d\ic_launcher_foreground.png") ([int]($px * 2.25)) 0.48 $false
}
Get-ChildItem $res -Recurse -Filter splash.png | ForEach-Object { Save-Splash $_.FullName }

# iOS: a App Store exige ícone sem transparência, por isso leva o fundo Aero
$ios = Join-Path $root 'ios\App\App\Assets.xcassets'
if (Test-Path $ios) {
  Save-Logo (Join-Path $ios 'AppIcon.appiconset\AppIcon-512@2x.png') 1024 0.92 $true
  Get-ChildItem (Join-Path $ios 'Splash.imageset') -Filter *.png | ForEach-Object { Save-Splash $_.FullName }
}
$logo.Dispose()
Write-Output 'Icones gerados.'
