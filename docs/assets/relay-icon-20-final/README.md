# Relay 图标

当前定稿为浅紫磨砂玻璃底与半透明折带 R，桌面及移动端分别保留适合各平台的裁切。

- `relay-r-frosted-master.png`：原始生成图，提示词见 `prompt.txt`。
- `relay-r-frosted-desktop.png`：透明圆角桌面图稿。
- `relay-r-frosted-mobile-1080.png`：108 dp 自适应图标画布，按 10 倍采样。
- `relay-r-frosted-mobile-square.png`：中央 72 dp 可见区域。
- `relay-r-frosted-crop-preview.png`：桌面、圆形和圆角静态预览。

在项目根目录运行 `python scripts/export-icons.py`，从本目录的定稿导出网页、桌面 PNG／ICO／ICNS 与安卓各密度图标，需要 Pillow。安卓通知图标使用相同 R 轮廓的单色矢量图，主题图标复用该轮廓并保留自适应遮罩留白。
