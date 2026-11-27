#!/usr/bin/env python3
"""Công cụ dòng lệnh cho agent đồng bộ bản tin (dùng agent key, không cần mật khẩu quản trị).

    python3 agent-api.py lay > /tmp/nd.json          # tải nội dung hiện tại
    python3 agent-api.py anh <file ảnh> [tin|clb]     # tải ảnh lên, in ra đường dẫn up/<mã>.webp
    python3 agent-api.py dat /tmp/nd.json             # ghi nội dung mới lên web (thay đổi hiện ngay)
    python3 agent-api.py sao-luu                      # chép nội dung, ảnh và đơn về máy để lưu trữ

Biến môi trường: API (bắt buộc, ví dụ https://ten-worker.ten-tai-khoan.workers.dev hoặc domain riêng),
AGENT_KEY (giá trị đã đặt bằng `wrangler secret put AGENT_KEY`) hoặc AGENT_KEY_FILE (đường dẫn file chứa key).
"""
import base64, json, os, pathlib, sys, urllib.request

API = os.environ.get("API", "").rstrip("/")
if not API:
    sys.exit("Thiếu biến môi trường API (địa chỉ website, ví dụ https://ten-worker.workers.dev)")
KEY = os.environ.get("AGENT_KEY") or pathlib.Path(os.environ.get("AGENT_KEY_FILE", ".bi-mat/agent-key.txt")).read_text().strip()
ROOT = pathlib.Path(__file__).resolve().parent
SEED = ROOT / "server" / "seed"


def call(method, path, body=None, raw=False):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method,
                                 headers={"X-Agent-Key": KEY, "Content-Type": "application/json", "User-Agent": "doan-agent/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        out = r.read()
    return out if raw else json.loads(out)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd = sys.argv[1]
    if cmd == "lay":
        print(json.dumps(call("GET", "/api/noi-dung"), ensure_ascii=False, indent=1))
    elif cmd == "anh":
        p = pathlib.Path(sys.argv[2])
        mime = {".png": "png", ".webp": "webp"}.get(p.suffix.lower(), "jpeg")
        b64 = f"data:image/{mime};base64," + base64.b64encode(p.read_bytes()).decode()
        print(call("POST", "/api/anh", {"data": b64, "loai": sys.argv[3] if len(sys.argv) > 3 else "tin"})["anh"])
    elif cmd == "dat":
        nd = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
        call("PUT", "/api/noi-dung", nd)
        print("Đã ghi:", len(nd["banTin"]), "bài,", len(nd["clb"]), "CLB")
    elif cmd == "sao-luu":
        b = call("GET", "/api/sao-luu")
        (SEED / "noi-dung.json").write_text(json.dumps(b["noiDung"], ensure_ascii=False, indent=1), encoding="utf-8")
        # b["quanTri"] (hash mật khẩu, khoá Sheet) cố ý KHÔNG lưu vào thư mục dự án để khỏi lộ khi đưa lên git
        # đơn đặt merch: dữ liệu cá nhân, chỉ lưu cục bộ (đã .gitignore, không đưa vào zip)
        (SEED / "don-hang.json").write_text(json.dumps(b.get("donHang", []), ensure_ascii=False, indent=1), encoding="utf-8")
        up = SEED / "up"
        up.mkdir(exist_ok=True)
        moi = 0
        for name in b["anh"]:
            f = up / name
            if not f.exists():
                f.write_bytes(call("GET", "/up/" + name, raw=True))
                moi += 1
        # bản dự phòng cho trình duyệt khi máy chủ chưa phản hồi
        (ROOT / "public" / "noi-dung.js").write_text(
            "// Bản dự phòng tự sinh từ máy chủ, không sửa tay. Sửa nội dung tại /#admin.\nwindow.NOI_DUNG = "
            + json.dumps(b["noiDung"], ensure_ascii=False, indent=1) + ";\n", encoding="utf-8")
        print(f"Đã sao lưu {len(b['noiDung']['banTin'])} bài, {len(b['noiDung']['clb'])} CLB, {len(b.get('donHang', []))} đơn merch, {moi} ảnh mới")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
