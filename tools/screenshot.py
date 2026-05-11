#!/usr/bin/env python3
"""
Full-desktop screenshot — captures ALL monitors, saves PNG, prints file path.

Usage:
  python screenshot.py               # full desktop
  python screenshot.py <x> <y> <w> <h>   # region

Claude workflow:
  1. path = Bash("python C:/Users/moren/claude-tools/screenshot.py")
  2. Read(path.strip())   -> Claude sees the screen
"""
import sys
import os
import datetime

try:
    from PIL import ImageGrab
except ImportError:
    # Fallback: PowerShell via subprocess
    import subprocess, tempfile
    out = os.path.join(os.environ.get('TEMP', r'C:\Temp'),
        f'claude_screen_{datetime.datetime.now().strftime("%Y%m%d_%H%M%S_%f")}.png')
    ps = (
        'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;'
        '$b=[System.Windows.Forms.Screen]::AllScreens;'
        '$left=$b|%{$_.Bounds.Left}|sort|select -first 1;'
        '$top=$b|%{$_.Bounds.Top}|sort|select -first 1;'
        '$right=($b|%{$_.Bounds.Right}|sort -desc|select -first 1);'
        '$bottom=($b|%{$_.Bounds.Bottom}|sort -desc|select -first 1);'
        '$w=$right-$left;$h=$bottom-$top;'
        '$bmp=New-Object System.Drawing.Bitmap($w,$h);'
        '$g=[System.Drawing.Graphics]::FromImage($bmp);'
        f'$g.CopyFromScreen($left,$top,0,0,(New-Object System.Drawing.Size($w,$h)));'
        f'$bmp.Save("{out}");$g.Dispose();$bmp.Dispose()'
    )
    subprocess.run(['powershell', '-Command', ps], capture_output=True)
    print(out)
    sys.exit(0)

out_dir = os.environ.get('TEMP', r'C:\Temp')
ts = datetime.datetime.now().strftime('%Y%m%d_%H%M%S_%f')
out = os.path.join(out_dir, f'claude_screen_{ts}.png')

if len(sys.argv) == 5:
    x, y, w, h = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
    img = ImageGrab.grab(bbox=(x, y, x + w, y + h), all_screens=True)
else:
    img = ImageGrab.grab(all_screens=True)

img.save(out)
print(out)
