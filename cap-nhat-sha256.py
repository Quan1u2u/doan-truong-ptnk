#!/usr/bin/env python3
"""Cập nhật mã băm SHA-256 (Subresource Integrity) cho CSS/JS trong mọi file .html.

Chạy lại MỖI KHI sửa noi-dung.js, app.js hoặc base.css:
    python3 cap-nhat-sha256.py

Trình duyệt sẽ từ chối chạy file nếu nội dung không khớp mã băm,
nên nếu quên chạy lệnh này sau khi sửa, trang sẽ bị trống phần nội dung.
Lệnh này cũng đổi tham số ?v= theo mã băm để trình duyệt tải bản mới.
"""
import base64, hashlib, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent / "public"
FILES = ["base.css", "noi-dung.js", "app.js", "admin.js"]


def sri_of(name):
    data = (ROOT / name).read_bytes()
    return "sha256-" + base64.b64encode(hashlib.sha256(data).digest()).decode(), hashlib.sha256(data).hexdigest()[:10]


for html_path in sorted(ROOT.glob("*.html")):
    html = html_path.read_text(encoding="utf-8")
    for name in FILES:
        sri, ver = sri_of(name)
        attr = "href" if name.endswith(".css") else "src"
        pat = re.compile(r'<(link|script)\b[^>]*\b' + attr + r'="\./' + re.escape(name) + r'(\?v=[^"]*)?"[^>]*>')
        m = pat.search(html)
        if not m and name == "admin.js":
            continue
        if not m:
            raise SystemExit(f"Không tìm thấy thẻ cho {name} trong {html_path.name}")
        if name.endswith(".css"):
            tag = f'<link rel="stylesheet" href="./{name}?v={ver}" integrity="{sri}" crossorigin="anonymous">'
        else:
            tag = f'<script src="./{name}?v={ver}" integrity="{sri}" crossorigin="anonymous">'
        html = html[:m.start()] + tag + html[m.end():]
    html_path.write_text(html, encoding="utf-8")
    print(f"Đã cập nhật {html_path.name}")

for name in FILES:
    print(f"{name:12} {sri_of(name)[0]}")
