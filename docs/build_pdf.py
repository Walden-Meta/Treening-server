# -*- coding: utf-8 -*-
"""把 Treening-操作手册.md 渲染为正式手册风格的 HTML，供 Edge headless 打印为 PDF。

版式：封面页 + 目录页 + 正文（每篇另起一页，带页眉页脚）。
"""
from pathlib import Path

import markdown

ROOT = Path(__file__).resolve().parent
MD = ROOT / "Treening-操作手册.md"
OUT_HTML = ROOT / "treening-manual.html"
OUT_PDF = ROOT / "Treening-操作手册.pdf"

CSS = """
@page {
  size: A4;
  margin: 17mm 16mm 19mm 16mm;
}
@page { @bottom-center { content: counter(page); font-family: "Microsoft YaHei", sans-serif; font-size: 9pt; color: #999; } }
@page { @top-center { content: "Treening · 操作手册"; font-family: "Microsoft YaHei", sans-serif; font-size: 8pt; letter-spacing: 1.5pt; color: #b3b3b3; } }
@page :first { @top-center { content: none; } }

html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Segoe UI", sans-serif; font-size: 10.5pt; line-height: 1.8; color: #222; margin: 0; }

/* ===== 封面页 ===== */
.cover {
  page-break-after: always;
  min-height: 259mm;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}
.cover .cover-eyebrow { font-size: 9pt; letter-spacing: 5pt; color: #8a9db0; text-transform: uppercase; margin: 0 0 12px; }
.cover h1 { page-break-before: avoid; border: none; font-size: 28pt; font-weight: 700; letter-spacing: 4pt; color: #0b3d6f; margin: 0; }
.cover h1::after { content: ""; display: block; width: 52mm; height: 1px; background: #c9d4e0; margin: 18px auto 0; }
.cover blockquote { border: none; background: none; color: #555; max-width: 142mm; margin: 15mm auto 0; font-size: 10.5pt; line-height: 2; }
.cover blockquote p { margin: 6px 0; }
.cover .cover-foot { margin-top: auto; font-size: 9pt; color: #999; letter-spacing: 1pt; }
.cover hr { display: none; }

/* ===== 目录页 ===== */
.toc { page-break-after: always; }
.toc h1 { page-break-before: avoid; }
.toc hr { display: none; }

/* ===== 正文 ===== */
.main h1 { page-break-before: always; }
h1 { font-size: 16pt; line-height: 1.3; color: #0b3d6f; border-bottom: 2px solid #0b3d6f; padding-bottom: 7px; margin: 0 0 16px; page-break-after: avoid; }
h2 { font-size: 13pt; color: #14508c; margin: 26px 0 10px; page-break-after: avoid; }
h3 { font-size: 11.5pt; color: #2a2a2a; margin: 20px 0 8px; page-break-after: avoid; }
h4 { font-size: 10.5pt; margin: 14px 0 6px; page-break-after: avoid; }
p { margin: 8px 0; text-align: justify; }
ul, ol { margin: 8px 0; padding-left: 24px; }
li { margin: 4px 0; }
strong { color: #111; }
a { color: #14508c; text-decoration: none; }
hr { border: none; border-top: 1px solid #d5d5d5; margin: 18px 0; }

blockquote { margin: 12px 0; padding: 10px 16px; background: #f6f8fa; border-left: 3px solid #7aa0c9; color: #444; page-break-inside: avoid; }
blockquote p { margin: 5px 0; }

table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 9.5pt; }
th { background: #eef3f8; border: 1px solid #c9d4e0; padding: 7px 9px; text-align: left; font-weight: 700; color: #0b3d6f; }
td { border: 1px solid #c9d4e0; padding: 6px 9px; vertical-align: top; }
tr { page-break-inside: avoid; }
tbody tr:nth-child(even) { background: #fafbfd; }

code { font-family: "Consolas", "Courier New", monospace; font-size: 8.8pt; background: #f2f2f2; padding: 1px 4px; border-radius: 3px; color: #b02a37; }
pre { background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 6px; padding: 10px 14px; white-space: pre-wrap; word-break: break-all; font-family: "Consolas", "Courier New", monospace; font-size: 8.5pt; line-height: 1.55; page-break-inside: avoid; }
pre code { background: transparent; padding: 0; color: inherit; }
"""


def main() -> None:
    text = MD.read_text(encoding="utf-8")
    body = markdown.markdown(
        text,
        extensions=["tables", "fenced_code", "sane_lists", "attr_list"],
    )

    # 切成 封面 / 目录 / 正文 三段
    cover_end = body.index("<h1>目录")
    toc_end = body.index("<h1>第一篇")
    cover_html = body[:cover_end]
    toc_html = body[cover_end:toc_end]
    main_html = body[toc_end:]

    # 封面装饰：eyebrow + 精简大标题 + 底部版本信息
    cover_html = cover_html.replace(
        "<h1>",
        '<p class="cover-eyebrow">TREENING / 操作手册</p><h1>',
        1,
    )
    cover_html = cover_html.replace(
        "Treening · 操作手册</h1>",
        "Treening</h1>",
        1,
    )
    cover_html += (
        '<p class="cover-foot">版本 v0.2.0 ｜ 更新于 2026-08-07 ｜ '
        "https://treening.cc</p>"
    )

    html = (
        "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n"
        "<meta charset=\"UTF-8\">\n"
        "<title>Treening · 操作手册</title>\n"
        f"<style>{CSS}</style>\n"
        "</head>\n<body>\n"
        f'<section class="cover">{cover_html}</section>\n'
        f'<section class="toc">{toc_html}</section>\n'
        f'<section class="main">{main_html}</section>\n'
        "</body>\n</html>\n"
    )
    OUT_HTML.write_text(html, encoding="utf-8")
    print(f"HTML OK: {OUT_HTML} ({len(html)} chars)")


if __name__ == "__main__":
    main()
