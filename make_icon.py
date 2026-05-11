"""
make_icon.py -- Generate black edition icons for Claude Codex Black Ed.
The Claude logo is a filled circle with an internal asterisk pattern.
We desaturate + boost contrast to reveal that pattern, then invert for themes.

Output:
  resources/icon.png       -- 128x128 black circle, white asterisk (extension panel)
  resources/icon-dark.png  -- 32x32 for dark VSCode theme (white logo on transparent)
  resources/icon-light.png -- 32x32 for light VSCode theme (black logo on transparent)

Run: python make_icon.py
"""

import subprocess, shutil, sys, os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RESOURCES  = os.path.join(SCRIPT_DIR, 'resources')
CACHED_SRC = os.path.join(RESOURCES, 'claude-logo-source.png')

EXT_ROOT = os.path.join(os.path.expanduser('~'), '.vscode', 'extensions')
os.makedirs(RESOURCES, exist_ok=True)

def findSource():
    if os.path.exists(CACHED_SRC):
        return CACHED_SRC
    if os.path.isdir(EXT_ROOT):
        for d in sorted(os.listdir(EXT_ROOT), reverse=True):
            if d.startswith('anthropic.claude-code-'):
                p = os.path.join(EXT_ROOT, d, 'resources', 'claude-logo.png')
                if os.path.exists(p):
                    shutil.copy2(p, CACHED_SRC)
                    print(f'  Cached source -> {CACHED_SRC}')
                    return CACHED_SRC
    raise RuntimeError('Claude logo not found. Install Claude Code extension first.')

def findMagick():
    for cmd in ['magick', 'convert']:
        if shutil.which(cmd): return cmd
    raise RuntimeError('ImageMagick not found. Install: choco install imagemagick')

def run(args, label):
    print(f'  {label}...')
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        print(f'  ERROR: {r.stderr.strip()}')
        sys.exit(1)
    print('  OK')

def main():
    magick = findMagick()
    src    = findSource()
    print(f'ImageMagick: {magick}')
    print(f'Source:      {src}')

    out128 = os.path.join(RESOURCES, 'icon.png')
    out32d = os.path.join(RESOURCES, 'icon-dark.png')
    out32l = os.path.join(RESOURCES, 'icon-light.png')

    # Shared processing chain:
    # 1. Flatten onto white (removes transparency artifacts)
    # 2. Desaturate to reveal internal contrast (asterisk vs circle)
    # 3. Boost contrast so the asterisk pops clearly
    # 4. Invert: dark circle with white asterisk
    PROCESS = [
        '-background', 'white', '-flatten',
        '-colorspace', 'Gray',
        '-sigmoidal-contrast', '8,50%',   # strong S-curve to boost contrast
        '-negate',                         # invert: circle=black, asterisk=white
    ]

    # 128x128 for extension panel (black circle, white asterisk, white bg)
    run([magick, src, '-resize', '128x128'] + PROCESS + [out128],
        f'128x128 -> {out128}')

    # 32x32 dark theme: white circle, black asterisk, transparent bg
    # We need to put it on transparent, not white
    # Process on white, then make white transparent
    run([
        magick, src, '-resize', '32x32',
        '-background', 'white', '-flatten',
        '-colorspace', 'Gray',
        '-sigmoidal-contrast', '8,50%',
        # DON'T invert: dark circle on white -> white bg becomes transparent
        '-negate',                          # black circle, white asterisk
        '-negate',                          # back: white circle, black asterisk
        # For dark theme we want LIGHT logo on transparent
        # Make bg (white) transparent, then invert colors
        '-fuzz', '5%', '-transparent', 'white',  # remove white bg
        '-negate',                                  # invert remaining: dark->light
        out32d
    ], f'32x32 dark theme -> {out32d}')

    # 32x32 light theme: black circle, white asterisk, transparent bg
    run([
        magick, src, '-resize', '32x32',
        '-background', 'white', '-flatten',
        '-colorspace', 'Gray',
        '-sigmoidal-contrast', '8,50%',
        '-negate',                                  # black circle, white asterisk
        '-fuzz', '5%', '-transparent', 'white',    # make white transparent
        out32l
    ], f'32x32 light theme -> {out32l}')

    print(f'\nDone. Icons in: {RESOURCES}')

if __name__ == '__main__':
    main()
