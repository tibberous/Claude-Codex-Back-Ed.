"""Image slicer — uses cropRgbBuffer from C:\\TrioDesktop\\start.py:20846.

Reads an image, splits it into a rows*cols grid, writes each tile to disk.

Usage:
  python slider.py <input.png> <output_dir> <rows> <cols>

Example (3x3 for 9-patch skin):
  python slider.py good.png slices/ 3 3
"""

import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("requires Pillow: pip install Pillow")


def cropRgbBuffer(width, height, rgbBytes, x, y, cropWidth, cropHeight):
    """Lifted verbatim from C:\\TrioDesktop\\start.py:20846 (TrioDesktop.cropRgbBuffer).
    Pure-Python rectangle crop on an RGB byte buffer; walks rows, no PIL on the slice itself."""
    sourceWidth = int(width or 0)
    sourceHeight = int(height or 0)
    left = max(0, min(sourceWidth, int(x or 0)))
    top = max(0, min(sourceHeight, int(y or 0)))
    right = max(left, min(sourceWidth, left + max(1, int(cropWidth or 0))))
    bottom = max(top, min(sourceHeight, top + max(1, int(cropHeight or 0))))
    targetWidth = max(1, right - left)
    targetHeight = max(1, bottom - top)
    rowStride = sourceWidth * 3
    cropped = bytearray(targetWidth * targetHeight * 3)
    targetOffset = 0
    for rowIndex in range(top, bottom):
        start = (rowIndex * rowStride) + (left * 3)
        end = start + (targetWidth * 3)
        segment = rgbBytes[start:end]
        cropped[targetOffset:targetOffset + len(segment)] = segment
        targetOffset += len(segment)
    return targetWidth, targetHeight, bytes(cropped)


def main(argv):
    if len(argv) != 5:
        sys.exit("usage: slider.py <input.png> <output_dir> <rows> <cols>")
    inPath = Path(argv[1])
    outDir = Path(argv[2])
    rows = int(argv[3])
    cols = int(argv[4])
    outDir.mkdir(parents=True, exist_ok=True)

    img = Image.open(inPath).convert('RGB')
    width, height = img.size
    rgbBytes = img.tobytes()

    tileW = width // cols
    tileH = height // rows
    for r in range(rows):
        for c in range(cols):
            x = c * tileW
            y = r * tileH
            cw = tileW if c < cols - 1 else width - x
            ch = tileH if r < rows - 1 else height - y
            outW, outH, data = cropRgbBuffer(width, height, rgbBytes, x, y, cw, ch)
            outPath = outDir / f"slice_{r}_{c}.png"
            Image.frombytes('RGB', (outW, outH), data).save(outPath)
            print(f"wrote {outPath}  {outW}x{outH}")


if __name__ == '__main__':
    main(sys.argv)
