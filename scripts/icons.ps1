Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Path "$PSScriptRoot/../public/icons" -Force | Out-Null
foreach ($iconSize in @(16, 32, 48, 128)) {
    $bitmap = New-Object System.Drawing.Bitmap($iconSize, $iconSize)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.ScaleTransform(($iconSize / 128), ($iconSize / 128))
    $background = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#2b634c'))
    $foreground = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#eff5de'))
    $shape = New-Object System.Drawing.Drawing2D.GraphicsPath
    $shape.AddArc(2, 2, 40, 40, 180, 90)
    $shape.AddArc(86, 2, 40, 40, 270, 90)
    $shape.AddArc(86, 86, 40, 40, 0, 90)
    $shape.AddArc(2, 86, 40, 40, 90, 90)
    $shape.CloseFigure()
    $graphics.FillPath($background, $shape)
    $graphics.FillRectangle($foreground, 26, 43, 49, 43)
    $points = [System.Drawing.PointF[]]@((New-Object System.Drawing.PointF(75, 56)), (New-Object System.Drawing.PointF(101, 43)), (New-Object System.Drawing.PointF(101, 86)), (New-Object System.Drawing.PointF(75, 73)))
    $graphics.FillPolygon($foreground, $points)
    $bitmap.Save((Join-Path $PSScriptRoot "../public/icons/icon$iconSize.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose(); $bitmap.Dispose(); $shape.Dispose(); $background.Dispose(); $foreground.Dispose()
}
