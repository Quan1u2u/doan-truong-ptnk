#!/usr/bin/env python3
"""Agent đồng bộ bản tin từ fanpage Ban Chấp hành Đoàn trường PTNK lên website.

Lấy N bài mới nhất (mặc định 20) qua Facebook Graph API, so với danh sách bản tin đang có:
  - bài đã có (trùng mã bài hoặc trùng link)  -> bỏ qua
  - bài chưa có                                -> thu nhỏ ảnh, tải ảnh lên, thêm vào đầu danh sách bản tin
Các bản tin cũ không bị sửa. Bản tin mới được lưu cùng định dạng với các bản tin trước (id, nhom, nhan, ngay,
trangThai, han, tieuDe, moTa, anh, link). Nhóm, nhãn và hạn chót được đoán theo từ khoá; hãy xem lại trong
trang quản trị sau khi agent chạy.

    python3 agent-fanpage.py --thu          # chỉ in ra bài sẽ thêm, không ghi gì
    python3 agent-fanpage.py                # thêm bài mới lên website
    python3 agent-fanpage.py --so-bai 10

Biến môi trường:
    FB_PAGE_TOKEN   (bắt buộc) Page access token của fanpage, quyền pages_read_engagement
    API             địa chỉ website, ví dụ https://doantruongptnk.phamlmquan.workers.dev
    AGENT_KEY       khoá agent (cùng giá trị secret AGENT_KEY của Worker)
    FB_PAGE_ID      mặc định "me" (trang ứng với Page token; không cần đặt)
    FB_GRAPH        mặc định https://graph.facebook.com/v21.0
Cần thư viện Pillow để thu nhỏ ảnh (pip install pillow); thiếu Pillow thì bài vẫn được thêm nhưng không có ảnh.
"""
import argparse, base64, http.client, io, json, os, re, sys, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone

VN = timezone(timedelta(hours=7))
UA = "doan-fanpage-agent/1.0"
PAGE = os.environ.get("FB_PAGE_ID", "me")
GRAPH = os.environ.get("FB_GRAPH", "https://graph.facebook.com/v21.0").rstrip("/")
EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿⬀-⯿️‍]")


def loi(msg):
    sys.exit("Lỗi: " + msg)


def yeu_cau(url, data=None, headers=None, method=None, timeout=60):
    req = urllib.request.Request(url, data=data, method=method, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ------------------------------------------------------------ Facebook
def lay_bai(token, so_bai):
    q = urllib.parse.urlencode({"fields": "id,message,created_time,permalink_url,full_picture", "limit": so_bai, "access_token": token})
    try:
        d = json.loads(yeu_cau(f"{GRAPH}/{PAGE}/posts?{q}"))
    except urllib.error.HTTPError as e:
        try:
            m = json.loads(e.read()).get("error", {})
        except Exception:
            m = {}
        goi_y = " Token hết hạn hoặc sai: tạo lại Page access token." if m.get("code") == 190 else \
                " Token thiếu quyền pages_read_engagement hoặc không phải quản trị viên trang." if m.get("code") in (10, 200, 283) else ""
        loi(f"Facebook trả về lỗi {e.code}: {m.get('message', 'không rõ')}.{goi_y}")
    except (OSError, http.client.HTTPException) as e:
        loi(f"Không kết nối được Facebook: {getattr(e, 'reason', e)}")
    return d.get("data", [])


# ------------------------------------------------------------ chuyển bài đăng thành bản tin
def sach(text):
    text = re.sub(r"https?://\S+", " ", text or "")
    text = re.sub(r"#\w+", " ", text)
    return EMOJI.sub("", text)


def cat(s, n):
    s = re.sub(r"\s+", " ", s).strip()
    if len(s) <= n:
        return s
    c = s[:n - 1]
    return (c[:c.rfind(" ")] if " " in c[n // 2:] else c).rstrip(" ,;:–-") + "…"


def tieu_de_mo_ta(message, ngay_dang):
    dong = [re.sub(r"\s+", " ", x).strip(" -–•*:") for x in sach(message).splitlines()]
    dong = [x for x in dong if x]
    if not dong:
        return f"Bài đăng trên fanpage ngày {ngay_dang}", ""
    tieu = cat(dong[0], 150)
    mo_ta = cat(" ".join(dong[1:]) or "", 300)
    return tieu, mo_ta


def phan_loai(tieu, noi_dung):
    t = (tieu + " " + noi_dung[:200]).lower()
    ten = tieu.lower()
    if any(k in t for k in ("20/11", "nhà giáo")):
        return "hc", "Mừng 20/11"
    if any(k in t for k in ("quốc khánh", "2/9", "ngày quốc tế", "8/3", "26/3", "trung thu", "tết")):
        return "hc", "Ngày lễ"
    if any(k in ten for k in ("thông báo", "nghị định", "quy định", "thông tư", "lưu ý")):
        return "tb", "Thông báo"
    if any(k in t for k in ("hội thao", "cuộc thi", "poster", "casting", "liên hoan", "phong trào", "hội trại", "thi đấu", "giải đấu")):
        return "pt", "Phong trào"
    return "clb", "Đoàn & CLB"


def tim_han(message, dang):
    """Bài mở đơn có hạn chót còn hiệu lực -> ISO 8601 (+07:00); ngược lại trả None."""
    text = sach(message)
    if not re.search(r"mở đơn|đăng ký|điền đơn|tuyển|nộp (bài|sản phẩm)|đơn đăng", text, re.I):
        return None
    for line in text.splitlines():
        if not re.search(r"hạn|deadline|đóng đơn|đến hết|trước", line, re.I):
            continue
        m = re.search(r"(\d{1,2})\s*/\s*(\d{1,2})(?:\s*/\s*(\d{4}))?", line)
        if not m:
            continue
        d, mo = int(m.group(1)), int(m.group(2))
        y = int(m.group(3)) if m.group(3) else dang.year
        g = re.search(r"(\d{1,2})\s*(?:g|h|:)\s*(\d{2})", line)
        gio, phut = (int(g.group(1)), int(g.group(2))) if g else (23, 59)
        try:
            han = datetime(y, mo, d, gio, phut, tzinfo=VN)
        except ValueError:
            continue
        if not m.group(3) and han < dang:
            han = han.replace(year=y + 1)
        return han.isoformat(timespec="seconds") if han >= datetime.now(VN) else None
    return None


def thu_nho_anh(url):
    """Tải ảnh bài đăng, thu nhỏ còn tối đa 1000px, đổi sang WebP. Trả về bytes hoặc None."""
    try:
        from PIL import Image
    except ImportError:
        print("  ! Chưa cài Pillow, bỏ qua ảnh (pip install pillow)")
        return None
    try:
        im = Image.open(io.BytesIO(yeu_cau(url)))
        im = im.convert("RGB")
        im.thumbnail((1000, 1000))
        b = io.BytesIO()
        im.save(b, "WEBP", quality=82, method=4)
        return b.getvalue()
    except Exception as e:
        print(f"  ! Không xử lý được ảnh: {type(e).__name__}")
        return None


def tao_ban_tin(p, tai_anh):
    post_id = p["id"].split("_")[-1]
    dang = datetime.strptime(p["created_time"], "%Y-%m-%dT%H:%M:%S%z").astimezone(VN)
    ngay = dang.strftime("%d/%m/%Y")
    message = p.get("message", "")
    tieu, mo_ta = tieu_de_mo_ta(message, ngay)
    nhom, nhan = phan_loai(tieu, message)
    link = p.get("permalink_url") or f"https://www.facebook.com/{PAGE}/posts/{post_id}/"
    if link.startswith("/"):
        link = "https://www.facebook.com" + link
    item = {"id": post_id, "nhom": nhom, "nhan": nhan, "ngay": f"Đăng {ngay}", "trangThai": "done"}
    han = tim_han(message, dang)
    if han:
        item["trangThai"], item["han"] = "open", han
    item.update({"tieuDe": tieu, "moTa": mo_ta, "anh": "", "link": link})
    if tai_anh and p.get("full_picture"):
        item["_anh"] = p["full_picture"]
    item["_dang"] = dang
    return item


# ------------------------------------------------------------ website
class Web:
    def __init__(self, api, key):
        self.api, self.key = api.rstrip("/"), key

    def call(self, method, path, body=None):
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        try:
            return json.loads(yeu_cau(self.api + path, data=data, method=method,
                                   headers={"X-Agent-Key": self.key, "Content-Type": "application/json"}))
        except urllib.error.HTTPError as e:
            try:
                ct = json.loads(e.read()).get("detail")
            except Exception:
                ct = ""
            loi(f"Website trả về {e.code} ở {path}: {ct}")
        except (OSError, http.client.HTTPException) as e:
            loi(f"Không kết nối được website ({path}): {getattr(e, 'reason', e)}")

    def up_anh(self, webp):
        return self.call("POST", "/api/anh", {"data": "data:image/webp;base64," + base64.b64encode(webp).decode(), "loai": "tin"})["anh"]


def ma_bai_trong_link(url):
    """Chỉ lấy mã bài (sau /posts/, /reel/, /videos/, /photos/..., fbid=), KHÔNG lấy mã trang có trong mọi link."""
    return set(re.findall(r"(?:/posts/|/reel/|/videos/|/photos/(?:[^/?]+/)?|[?&](?:story_)?fbid=|[?&]v=)(\d{8,})", url or ""))


def ngay_cua(n):
    m = re.search(r"(\d{2})/(\d{2})/(\d{4})", n.get("ngay", ""))
    return f"{m.group(3)}{m.group(2)}{m.group(1)}" if m else "00000000"


def main():
    ap = argparse.ArgumentParser(description="Đồng bộ bản tin từ fanpage lên website")
    ap.add_argument("--so-bai", type=int, default=20, help="số bài mới nhất cần xét (mặc định 20)")
    ap.add_argument("--thu", action="store_true", help="chỉ in ra bài sẽ thêm, không ghi gì lên website")
    a = ap.parse_args()

    token = os.environ.get("FB_PAGE_TOKEN", "")
    api, key = os.environ.get("API", ""), os.environ.get("AGENT_KEY", "")
    if not token:
        loi("thiếu biến môi trường FB_PAGE_TOKEN")
    if not api or not key:
        loi("thiếu biến môi trường API hoặc AGENT_KEY")
    web = Web(api, key)

    bai = lay_bai(token, max(1, min(a.so_bai, 100)))
    nd = web.call("GET", "/api/noi-dung")
    co_san = set()
    for n in nd["banTin"]:
        co_san.add(str(n.get("id")))
        co_san |= ma_bai_trong_link(n.get("link", ""))

    moi, bo_qua = [], 0
    for p in bai:
        post_id = p["id"].split("_")[-1]
        digits = ma_bai_trong_link(p.get("permalink_url", "")) | {post_id}
        if digits & co_san:
            bo_qua += 1
            continue
        if not p.get("message") and not p.get("full_picture"):
            print(f"- bỏ qua bài {post_id}: không có chữ lẫn ảnh")
            continue
        moi.append(tao_ban_tin(p, tai_anh=not a.thu))
        co_san |= digits
    print(f"Đã xét {len(bai)} bài: {bo_qua} bài đã có, {len(moi)} bài mới.")

    for it in moi:
        print(f"+ [{it['nhom']}/{it['nhan']}] {it['ngay']} · {it['trangThai']}{' đến ' + it['han'] if 'han' in it else ''} · {it['tieuDe']}")
    if a.thu or not moi:
        if a.thu and moi:
            print("(chế độ --thu: chưa ghi gì lên website)")
        return

    for it in moi:
        if it.get("_anh"):
            webp = thu_nho_anh(it["_anh"])
            if webp:
                it["anh"] = web.up_anh(webp)
        it.pop("_anh", None)
        it.pop("_dang", None)

    # đọc lại ngay trước khi ghi để không đè lên chỉnh sửa vừa làm trong trang quản trị
    nd = web.call("GET", "/api/noi-dung")
    ids = {str(n["id"]) for n in nd["banTin"]}
    them = [it for it in moi if it["id"] not in ids]
    tat_ca = them + nd["banTin"]
    tat_ca = [n for _, n in sorted(enumerate(tat_ca), key=lambda x: (ngay_cua(x[1]) == "00000000", -int(ngay_cua(x[1])), x[0]))]
    nd["banTin"] = tat_ca
    r = web.call("PUT", "/api/noi-dung", nd)
    print(f"Đã thêm {len(them)} bản tin. Tổng {r.get('soBai')} bài. Xem lại nhóm, nhãn và hạn chót trong trang quản trị.")


if __name__ == "__main__":
    main()
