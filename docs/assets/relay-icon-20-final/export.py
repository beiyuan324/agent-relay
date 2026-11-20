from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageChops, ImageFilter
import json

root = Path(__file__).resolve().parent
source = Image.open(root / "relay-r-frosted-master.png").convert("RGBA")
n = source.width
matte = "#f1eff8"

# 单独导出选定方案；保留原始生成稿。
desktop = source.crop((round(n * .05), round(n * .05), round(n * .95), round(n * .95))).resize((1024, 1024), Image.Resampling.LANCZOS)
edge = Image.new("L", (1024, 1024), 0)
ImageDraw.Draw(edge).rounded_rectangle((14, 16, 1010, 1012), radius=230, fill=255)
edge = edge.filter(ImageFilter.GaussianBlur(1))
desktop.putalpha(ImageChops.darker(desktop.getchannel("A"), edge))
desktop.save(root / "relay-r-frosted-desktop.png")
desktop_preview = Image.new("RGBA", (1024, 1024), matte)
desktop_preview.alpha_composite(desktop)
desktop_preview.convert("RGB").save(root / "relay-r-frosted-preview.png")

# 108 dp 图稿按 10 倍采样，预览中央 72 dp 可见区域。
adaptive_canvas = Image.new("RGBA", (1080, 1080), matte)
art = source.resize((994, 994), Image.Resampling.LANCZOS)
adaptive_canvas.alpha_composite(art, (43, 43))
adaptive_canvas.convert("RGB").save(root / "relay-r-frosted-mobile-1080.png")
visible = adaptive_canvas.crop((180, 180, 900, 900)).resize((1024, 1024), Image.Resampling.LANCZOS).convert("RGB")
visible.save(root / "relay-r-frosted-mobile-square.png")

def shaped(image, form):
    mask = Image.new("L", (1024, 1024), 0)
    d = ImageDraw.Draw(mask)
    if form == "circle":
        d.ellipse((0, 0, 1023, 1023), fill=255)
    else:
        d.rounded_rectangle((0, 0, 1023, 1023), radius=240, fill=255)
    out = image.convert("RGBA")
    out.putalpha(mask)
    return out

round_icon = shaped(visible, "circle")
round_icon.save(root / "relay-r-frosted-mobile-round.png")
rounded_icon = shaped(visible, "rounded")
rounded_icon.save(root / "relay-r-frosted-mobile-rounded.png")

font_path = r"C:\Windows\Fonts\msyh.ttc"
title = ImageFont.truetype(font_path, 38)
font = ImageFont.truetype(font_path, 26)
small = ImageFont.truetype(font_path, 21)
board = Image.new("RGBA", (1440, 760), "#eeeff5")
d = ImageDraw.Draw(board)
d.text((40, 24), "RELAY · 20 号精修", font=title, fill="#393b61")
d.text((42, 80), "浅紫磨砂玻璃 · 半透明折带 R", font=small, fill="#6d6c86")
for i, (im, label) in enumerate(((desktop, "桌面图稿"), (round_icon, "移动端 · 圆形裁切"), (rounded_icon, "移动端 · 圆角裁切"))):
    board.alpha_composite(im.resize((400, 400), Image.Resampling.LANCZOS), (40 + 480 * i, 140))
    d.text((240 + 480 * i, 566), label, font=font, fill="#474663", anchor="mt")
    thumb = im.resize((64, 64), Image.Resampling.LANCZOS)
    board.alpha_composite(thumb, (118 + 480 * i, 640))
    d.text((206 + 480 * i, 659), "64 px 预览", font=small, fill="#73728b")
board.convert("RGB").save(root / "relay-r-frosted-crop-preview.png")
notes = {
    "selection": 20,
    "generator": "imagegen25 / gpt-image-2.5-flare",
    "quality": "max",
    "source_dimensions": source.size,
    "desktop": "relay-r-frosted-desktop.png",
    "mobile_artwork_108dp_at_10x": "relay-r-frosted-mobile-1080.png",
    "mobile_visible_window": [180, 180, 900, 900],
    "mobile_square": "relay-r-frosted-mobile-square.png",
    "crop_preview": "relay-r-frosted-crop-preview.png",
    "android_design_reference": "https://developer.android.com/develop/ui/compose/system/icon_design_adaptive",
    "scope": "高清设计稿、移动端图稿及静态裁切预览；未打包或在设备启动器中运行。"
}
(root / "export.json").write_text(json.dumps(notes, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(notes, ensure_ascii=False))
