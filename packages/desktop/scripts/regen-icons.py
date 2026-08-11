#!/usr/bin/env python3
"""从 packages/desktop/app-icon.png 生成全套桌面端图标资源，分发到 beta/dev/prod 三个 env。

依赖：
  - macOS 自带 sips / iconutil
  - Python PIL/Pillow

不动 android/、ios/ 子目录（移动端资源单独维护）。

带 `--brand codex` 时改读 app-icon-codex.png，分发到 icons/codex/（同一套派生流程）。
"""
import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument("--brand", choices=["wanlai", "codex"], default="wanlai")
ARGS = parser.parse_args()

ROOT = Path(__file__).resolve().parent.parent
if ARGS.brand == "codex":
    SOURCE = ROOT / "app-icon-codex.png"
    ENVS = ["codex"]
else:
    SOURCE = ROOT / "app-icon.png"
    ENVS = ["beta", "dev", "prod"]
ICONS_DIR = ROOT / "icons"

# 源图按 Big Sur 模板：黑底 squircle 824×824 居中 + 100px 透明 padding。
# macOS 需要 padding（系统会画 drop shadow），Windows / Linux 不画阴影，
# 留 padding 会让桌面/任务栏图标看起来比同屏其他应用小一圈。
PADDING = 100

# (filename, pixel size, use_unpadded)
# use_unpadded=True 表示先 crop 掉 100px padding 再放大到 1024，去掉外圈透明边。
PNGS = [
    # Linux 桌面图标 —— 撑满
    ("128x128.png", 128, True),
    ("128x128@2x.png", 256, True),
    ("32x32.png", 32, True),
    ("64x64.png", 64, True),
    # Windows Store / UWP Tile —— 撑满
    ("Square107x107Logo.png", 107, True),
    ("Square142x142Logo.png", 142, True),
    ("Square150x150Logo.png", 150, True),
    ("Square284x284Logo.png", 284, True),
    ("Square30x30Logo.png", 30, True),
    ("Square310x310Logo.png", 310, True),
    ("Square44x44Logo.png", 44, True),
    ("Square71x71Logo.png", 71, True),
    ("Square89x89Logo.png", 89, True),
    ("StoreLogo.png", 50, True),
    # macOS Dock / 通用预览 —— 保留 padding
    ("dock.png", 256, False),
    ("icon.png", 310, False),
]

# iconutil 要求的 iconset 内容
ICNS_SIZES = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def resize(src_img: Image.Image, size: int) -> Image.Image:
    return src_img.resize((size, size), Image.Resampling.LANCZOS)


def unpad(src_img: Image.Image) -> Image.Image:
    """裁掉 Big Sur 模板的外圈透明 padding，再缩放回原尺寸。"""
    w, h = src_img.size
    cropped = src_img.crop((PADDING, PADDING, w - PADDING, h - PADDING))
    return cropped.resize((w, h), Image.Resampling.LANCZOS)


def build_icns(src_img: Image.Image, out_path: Path, work_dir: Path) -> None:
    iconset = work_dir / "icon.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir(parents=True)
    for name, size in ICNS_SIZES:
        resize(src_img, size).save(iconset / name, format="PNG")
    subprocess.run(
        ["iconutil", "-c", "icns", str(iconset), "-o", str(out_path)],
        check=True,
    )
    shutil.rmtree(iconset)


def build_ico(src_img: Image.Image, out_path: Path) -> None:
    sizes = [(s, s) for s in ICO_SIZES]
    src_img.save(out_path, format="ICO", sizes=sizes)


def main() -> int:
    if not SOURCE.exists():
        print(f"ERROR: source not found: {SOURCE}", file=sys.stderr)
        return 1
    src = Image.open(SOURCE).convert("RGBA")
    if src.size != (1024, 1024):
        print(f"WARN: source is {src.size}, recommended 1024x1024", file=sys.stderr)

    # Windows / Linux 用的去 padding 版本（squircle 撑满画布）
    src_unpadded = unpad(src)

    work_dir = ROOT / ".icon-work"
    work_dir.mkdir(exist_ok=True)

    for env in ENVS:
        env_dir = ICONS_DIR / env
        env_dir.mkdir(parents=True, exist_ok=True)
        print(f"\n=== {env} ===")
        for name, size, use_unpadded in PNGS:
            target = env_dir / name
            source = src_unpadded if use_unpadded else src
            resize(source, size).save(target, format="PNG")
            tag = "unpad" if use_unpadded else "pad  "
            print(f"  png  {tag} {name:<28} {size}x{size}")
        build_icns(src, env_dir / "icon.icns", work_dir)
        print("  icns pad   icon.icns")
        build_ico(src_unpadded, env_dir / "icon.ico")
        print("  ico  unpad icon.ico")

    shutil.rmtree(work_dir, ignore_errors=True)
    print("\nDone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
