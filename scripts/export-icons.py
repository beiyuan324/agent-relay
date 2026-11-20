from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parents[1]
artwork = root / "docs/assets/relay-icon-20-final"
desktop = Image.open(artwork / "relay-r-frosted-desktop.png").convert("RGBA")
desktop.save(root / "public/relay-icon.png")
icons = root / "src-tauri/icons"
for name, size in (("32x32", 32), ("128x128", 128), ("128x128@2x", 256)):
    desktop.resize((size, size), Image.Resampling.LANCZOS).save(icons / f"{name}.png")
desktop.save(icons / "icon.ico", sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])
desktop.save(icons / "icon.icns")

# 自适应前景保留完整 108 dp 画布；普通图标使用中央 72 dp 的定稿裁切。
adaptive = Image.open(artwork / "relay-r-frosted-mobile-1080.png").convert("RGBA")
rounded = Image.open(artwork / "relay-r-frosted-mobile-rounded.png").convert("RGBA")
circle = Image.open(artwork / "relay-r-frosted-mobile-round.png").convert("RGBA")
resources = root / "src-tauri/gen/android/app/src/main/res"
for density, scale in (("mdpi", 1), ("hdpi", 1.5), ("xhdpi", 2), ("xxhdpi", 3), ("xxxhdpi", 4)):
    folder = resources / f"mipmap-{density}"
    for name, image, dp in (("ic_launcher", rounded, 48), ("ic_launcher_round", circle, 48), ("ic_launcher_foreground", adaptive, 108)):
        size = round(dp * scale)
        image.resize((size, size), Image.Resampling.LANCZOS).save(folder / f"{name}.png")
