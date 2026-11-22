#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Sinh báo cáo khoá luận .docx (format Trường ĐH Thăng Long, cùng khung với bao-cao-cia-triad/tao_bao_cao.py)
TỪ CHÍNH các chương markdown trong docs/thesis — báo cáo Word luôn khớp tài liệu trong repo, sinh lại được bất cứ lúc nào.

  python3 docs/thesis/tao_bao_cao_kltn.py      # cần python-docx, Pillow, LibreOffice (soffice), pdftotext

Chạy 2–3 lượt: lượt 1 dựng tài liệu → render PDF (LibreOffice, tuần tự, một tiến trình) để dò số trang của đề mục/bảng/
hình → lượt sau điền mục lục, danh mục bảng, danh mục hình đúng số trang.
Chuyển markdown: # chương, ##/### đề mục, đoạn văn, danh sách (2 cấp), danh sách số, bảng pipe (có chú thích tự
động), khối code, trích dẫn; khối ```mermaid được thay bằng ảnh Graphviz đã render trong diagrams/out/.
"""
import os, re, subprocess, tempfile, unicodedata

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, Cm, RGBColor
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "BaoCao_KLTN_DevSecOps_AIOps.docx")
DIAG = os.path.join(ROOT, "diagrams", "out")
LOGO = os.path.join(ROOT, "assets", "logo_tlu.png")

FONT, MONO = "Times New Roman", "Courier New"
SV = {"ten": "Nguyễn Anh Đức", "msv": "A48274", "nganh": "Khoa học máy tính", "gv": "...................................."}
DE_TAI = ["XÂY DỰNG NỀN TẢNG DEVSECOPS TÍCH HỢP AIOPS", "CHO HỆ THỐNG THƯƠNG MẠI ĐIỆN TỬ", "KIẾN TRÚC MICROSERVICE TRÊN HẠ TẦNG HYBRID"]
TOKEN = re.compile(r"(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)")
CONTENT_W = 16.0     # cm (A4 21 − lề trái 3 − lề phải 2)

# chương theo thứ tự trình bày; "Kết luận" không đánh số chương, đứng sau chương mở rộng
CHUONG = ["01-dac-ta-bai-toan.md", "02-co-so-ly-thuyet.md", "03-thiet-ke.md", "04-trien-khai.md", "05-kiem-thu.md",
          "06-thuc-nghiem.md", "08-mo-rong-2026.md"]
KET_LUAN = "07-ket-luan.md"
# đề mục (bắt đầu bằng) → (ảnh, chú thích); khối mermaid ngay sau đề mục đó được thay bằng ảnh
HINH = {
    "Container và luồng chính": ("container.png", "Kiến trúc container và luồng chính của ShopNow"),
    "Saga checkout COD": ("saga.png", "Saga checkout COD (outbox/inbox, bù trừ)"),
    "Máy trạng thái đơn hàng": ("order-state.png", "Máy trạng thái đơn hàng"),
    "CI/CD → GitOps hybrid": ("cicd.png", "Pipeline CI/CD → GitOps trên hạ tầng hybrid"),
    "AIOps vòng kín": ("aiops-loop.png", "Vòng kín AIOps: phát hiện → RCA → khắc phục có duyệt"),
    "3.3. Phân rã service & dữ liệu": ("kafka.png", "Topology sự kiện Kafka giữa các service"),
    "4.7. Hạ tầng hybrid": ("deploy-hybrid.png", "Triển khai hybrid on-premises ↔ AWS"),
}


# ----------------------------------------------------------------- tiện ích định dạng (giống mẫu)
def font_run(run, name=FONT, size=None, bold=None, italic=None, color=None):
    run.font.name = name
    rf = run._element.get_or_add_rPr().get_or_add_rFonts()
    for a in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
        rf.set(qn(a), name)
    if size: run.font.size = Pt(size)
    if bold is not None: run.font.bold = bold
    if italic is not None: run.font.italic = italic
    if color: run.font.color.rgb = RGBColor.from_string(color)
    return run


def fix_style_font(style, size, bold=None, italic=None, color="000000"):
    rpr = style.element.get_or_add_rPr()
    rf = rpr.find(qn("w:rFonts"))
    if rf is None:
        rf = OxmlElement("w:rFonts"); rpr.insert(0, rf)
    for a in list(rf.attrib):
        if "Theme" in a: del rf.attrib[a]
    for a in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
        rf.set(qn(a), FONT)
    style.font.size = Pt(size)
    if bold is not None: style.font.bold = bold
    if italic is not None: style.font.italic = italic
    style.font.color.rgb = RGBColor.from_string(color)


def shade(el_pr, fill):
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear"); shd.set(qn("w:color"), "auto"); shd.set(qn("w:fill"), fill)
    el_pr.append(shd)


def field_run(par, instr, size=12):
    for kind, txt in (("begin", None), (None, instr), ("separate", None), (None, "1"), ("end", None)):
        r = par.add_run(); font_run(r, size=size)
        if kind:
            fc = OxmlElement("w:fldChar"); fc.set(qn("w:fldCharType"), kind); r._element.append(fc)
        elif txt == instr:
            it = OxmlElement("w:instrText"); it.set(qn("xml:space"), "preserve"); it.text = instr
            r._element.append(it)
        else:
            r.text = txt


def md_inline(text: str) -> str:
    """Bỏ cú pháp markdown không cần trong Word: link [a](b) → a, ảnh, thẻ HTML, ký tự thoát."""
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"<br\s*/?>", " ", text)
    return text.replace("\\|", "|").replace("\\*", "*")


class BaoCao:
    def __init__(self, trang):
        self.trang = trang
        self.d = Document()
        self.muc, self.bang, self.hinh = [], [], []
        self.chuong = 0; self.nb = 0; self.nh = 0
        self.h_cuoi = ""                  # đề mục gần nhất — làm chú thích bảng
        self._setup()

    def _setup(self):
        s = self.d.sections[0]
        s.page_width, s.page_height = Cm(21), Cm(29.7)
        s.left_margin, s.right_margin = Cm(3), Cm(2)
        s.top_margin, s.bottom_margin = Cm(2), Cm(2)
        s.footer_distance = Cm(1)
        fp = s.footer.paragraphs[0]; fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        field_run(fp, "PAGE")
        st = self.d.styles
        n = st["Normal"]; fix_style_font(n, 13)
        pf = n.paragraph_format
        pf.line_spacing = 1.4; pf.space_after = Pt(4); pf.space_before = Pt(0)
        fix_style_font(st["Heading 1"], 14, bold=True)
        fix_style_font(st["Heading 2"], 13, bold=True)
        fix_style_font(st["Heading 3"], 13, bold=True, italic=True)
        for h, before, after in (("Heading 1", 0, 12), ("Heading 2", 10, 4), ("Heading 3", 6, 2)):
            f = st[h].paragraph_format
            f.space_before, f.space_after = Pt(before), Pt(after)
            f.line_spacing = 1.3; f.keep_with_next = True
        st["Heading 1"].paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
        fix_style_font(st["List Bullet"], 13); fix_style_font(st["List Bullet 2"], 13)

    def _vien_bia(self):
        sp = self.d.sections[-1]._sectPr
        pb = OxmlElement("w:pgBorders"); pb.set(qn("w:offsetFrom"), "page")
        for side in ("top", "left", "bottom", "right"):
            e = OxmlElement(f"w:{side}")
            e.set(qn("w:val"), "thinThickSmallGap"); e.set(qn("w:sz"), "24")
            e.set(qn("w:space"), "24"); e.set(qn("w:color"), "1F3864")
            pb.append(e)
        sp.find(qn("w:pgMar")).addnext(pb)
        self.d.add_section(WD_SECTION.NEW_PAGE)
        sp.remove(pb)
        bia = self.d.sections[0]._sectPr
        for ref in bia.findall(qn("w:footerReference")) + bia.findall(qn("w:headerReference")):
            bia.remove(ref)

    def _inline(self, p, text, size=None, bold=None, italic=None):
        for part in TOKEN.split(md_inline(text)):
            if not part: continue
            if part.startswith("**"):
                font_run(p.add_run(part[2:-2]), size=size, bold=True, italic=italic)
            elif part.startswith("`"):
                font_run(p.add_run(part[1:-1]), name=MONO, size=(size or 13) - 1.5)
            elif part.startswith("*") and part.endswith("*") and len(part) > 2:
                font_run(p.add_run(part[1:-1]), size=size, bold=bold, italic=True)
            else:
                font_run(p.add_run(part), size=size, bold=bold, italic=italic)
        return p

    # ---------- khối nội dung
    def P(self, text, indent=True, align=WD_ALIGN_PARAGRAPH.JUSTIFY, **kw):
        p = self.d.add_paragraph(); p.alignment = align
        if indent: p.paragraph_format.first_line_indent = Cm(1)
        return self._inline(p, text, **kw)

    def C(self, text, size=13, bold=False, italic=False, after=0, before=0, color=None):
        p = self.d.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(after); p.paragraph_format.space_before = Pt(before)
        font_run(p.add_run(text), size=size, bold=bold, italic=italic, color=color)
        return p

    def B(self, text, level=1):
        p = self.d.add_paragraph(style="List Bullet" if level == 1 else "List Bullet 2")
        p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY; p.paragraph_format.space_after = Pt(2)
        self._inline(p, text)

    def N(self, num, text):
        p = self.d.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        p.paragraph_format.left_indent = Cm(1); p.paragraph_format.first_line_indent = Cm(-0.6)
        p.paragraph_format.space_after = Pt(2)
        self._inline(p, f"{num}. {text}")

    def QUOTE(self, text):
        p = self.d.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        p.paragraph_format.left_indent = Cm(1); p.paragraph_format.right_indent = Cm(0.5)
        self._inline(p, text, italic=True)

    def H1(self, text, so_chuong=True):
        if self.d.paragraphs: self.d.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
        if so_chuong:
            self.chuong += 1; self.nb = 0; self.nh = 0
            text = f"CHƯƠNG {self.chuong}. {text.upper()}"
        self.d.add_heading(text, level=1); self.muc.append((1, text)); self.h_cuoi = text

    def H2(self, text):
        self.d.add_heading(text, level=2); self.muc.append((2, text)); self.h_cuoi = text

    def H3(self, text):
        self.d.add_heading(text, level=3); self.muc.append((3, text)); self.h_cuoi = text

    def H4(self, text):
        p = self.d.add_paragraph(); p.paragraph_format.keep_with_next = True; p.paragraph_format.space_before = Pt(4)
        self._inline(p, text, bold=True)

    def _cap(self, nhan, text):
        p = self.d.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_before = Pt(6); p.paragraph_format.space_after = Pt(4)
        p.paragraph_format.keep_with_next = True
        font_run(p.add_run(nhan + " "), size=12, bold=True)
        font_run(p.add_run(text), size=12, italic=True)
        return p

    def T(self, caption, headers, rows, size=11):
        self.nb += 1
        nhan = f"Bảng {self.chuong}.{self.nb}." if self.chuong else f"Bảng {self.nb}."
        self._cap(nhan, caption); self.bang.append(f"{nhan} {caption}")
        ncol = len(headers)
        rows = [r + [""] * (ncol - len(r)) if len(r) < ncol else r[:ncol] for r in rows]
        # độ rộng cột theo độ dài nội dung (căn bậc hai để cột dài không nuốt hết), tối thiểu 1.6 cm
        lens = [max(len(md_inline(str(r[i]))) for r in [headers] + rows) for i in range(ncol)]
        wts = [max(4.0, L) ** 0.5 for L in lens]
        widths = [max(1.6, CONTENT_W * w / sum(wts)) for w in wts]
        k = CONTENT_W / sum(widths); widths = [w * k for w in widths]
        t = self.d.add_table(rows=1 + len(rows), cols=ncol)
        t.style = "Table Grid"; t.alignment = WD_TABLE_ALIGNMENT.CENTER; t.autofit = False
        size = size if ncol <= 4 else 10
        for ri, row in enumerate([headers] + rows):
            tr = t.rows[ri]
            tr._tr.get_or_add_trPr().append(OxmlElement("w:cantSplit"))
            if ri == 0:
                th = OxmlElement("w:tblHeader"); th.set(qn("w:val"), "true"); tr._tr.get_or_add_trPr().append(th)
            for ci, val in enumerate(row):
                cell = tr.cells[ci]; cell.width = Cm(widths[ci])
                if ri == 0: shade(cell._tc.get_or_add_tcPr(), "D9E2F3")
                cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
                p = cell.paragraphs[0]
                p.paragraph_format.first_line_indent = Cm(0); p.paragraph_format.line_spacing = 1.1
                p.paragraph_format.space_after = Pt(2); p.paragraph_format.space_before = Pt(2)
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER if ri == 0 else WD_ALIGN_PARAGRAPH.LEFT
                self._inline(p, str(val), size=size, bold=True if ri == 0 else None)
        for gc, w in zip(t._tbl.tblGrid.findall(qn("w:gridCol")), widths):
            gc.set(qn("w:w"), str(int(w * 567)))
        self.d.add_paragraph().paragraph_format.space_after = Pt(2)

    def IMG(self, path, caption, max_w=CONTENT_W, max_h=20.0):
        self.nh += 1
        w, h = Image.open(path).size
        width = min(max_w, max_h * w / h)
        p = self.d.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.keep_with_next = True; p.paragraph_format.space_before = Pt(6)
        p.add_run().add_picture(path, width=Cm(width))
        nhan = f"Hình {self.chuong}.{self.nh}." if self.chuong else f"Hình {self.nh}."
        c = self._cap(nhan, caption); c.paragraph_format.keep_with_next = False
        self.hinh.append(f"{nhan} {caption}")

    def CODE(self, text, size=9):
        p = self.d.add_paragraph()
        ppr = p._p.get_or_add_pPr()
        bdr = OxmlElement("w:pBdr")
        for side in ("top", "left", "bottom", "right"):
            e = OxmlElement(f"w:{side}"); e.set(qn("w:val"), "single"); e.set(qn("w:sz"), "4")
            e.set(qn("w:space"), "4"); e.set(qn("w:color"), "A6A6A6"); bdr.append(e)
        ppr.append(bdr); shade(ppr, "F4F6F8")
        pf = p.paragraph_format
        pf.line_spacing = 1.0; pf.space_before = Pt(4); pf.space_after = Pt(6)
        pf.left_indent = Cm(0.2); pf.right_indent = Cm(0.2)
        lines = text.rstrip("\n").split("\n")
        for i, ln in enumerate(lines):          # xuống dòng mềm trong cùng khối (không tạo đoạn rời)
            r = p.add_run(ln); font_run(r, name=MONO, size=size)
            if i < len(lines) - 1: r.add_break()

    # ---------- trang đầu
    def bia(self):
        C = self.C
        C("BỘ GIÁO DỤC VÀ ĐÀO TẠO", 14, True, before=6)
        C("TRƯỜNG ĐẠI HỌC THĂNG LONG", 14, True)
        C("KHOA CÔNG NGHỆ THÔNG TIN", 14, True, after=4)
        C("———————o0o———————", 12, after=18)
        p = self.d.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.add_run().add_picture(LOGO, width=Cm(4.2))
        C("KHOÁ LUẬN TỐT NGHIỆP", 18, True, before=24, after=4, color="1F3864")
        C(f"NGÀNH: {SV['nganh'].upper()}", 14, True, after=24)
        C("ĐỀ TÀI:", 13, True, after=6)
        for i, line in enumerate(DE_TAI):
            C(line, 16, True, color="C00000", after=4 if i == len(DE_TAI) - 1 else 0)
        C("(On-premises + AWS · ShopNow v2)", 13, italic=True, after=40)
        for k, v in (("Giảng viên hướng dẫn", SV["gv"]), ("Sinh viên thực hiện", SV["ten"]),
                     ("Mã sinh viên", SV["msv"]), ("Chuyên ngành", SV["nganh"])):
            p = self.d.add_paragraph(); p.paragraph_format.left_indent = Cm(2.2)
            p.paragraph_format.space_after = Pt(2)
            p.paragraph_format.tab_stops.add_tab_stop(Cm(7.6))
            font_run(p.add_run(f"{k}\t: "), size=13, bold=True)
            font_run(p.add_run(v), size=13)
        C("HÀ NỘI – 2026", 13, True, before=70)
        self._vien_bia()

    def _so_trang(self, key):
        return str(self.trang.get(key, "00"))

    def _dong_muc(self, text, level, key, first=False, last=False):
        p = self.d.add_paragraph(); pf = p.paragraph_format
        pf.left_indent = Cm({1: 0, 2: 0.6, 3: 1.2}[level]); pf.first_line_indent = Cm(0)
        pf.space_after = Pt(2 if level > 1 else 3); pf.space_before = Pt(4 if level == 1 else 0)
        pf.line_spacing = 1.15
        pf.tab_stops.add_tab_stop(Cm(16), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS)
        if first:
            for kind, instr in (("begin", None), (None, 'TOC \\o "1-3" \\h \\z \\u'), ("separate", None)):
                r = p.add_run()
                if kind:
                    fc = OxmlElement("w:fldChar"); fc.set(qn("w:fldCharType"), kind); r._element.append(fc)
                else:
                    it = OxmlElement("w:instrText"); it.set(qn("xml:space"), "preserve"); it.text = instr
                    r._element.append(it)
        sz = 12 if level > 1 else 13
        font_run(p.add_run(md_inline(text).replace("`", "")), size=sz, bold=(level == 1), italic=(level == 3))
        font_run(p.add_run("\t" + self._so_trang(key)), size=sz, bold=(level == 1))
        if last:
            r = p.add_run(); fc = OxmlElement("w:fldChar"); fc.set(qn("w:fldCharType"), "end"); r._element.append(fc)

    def _tieu_de_dau(self, text, ngat=True):
        if ngat: self.d.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
        self.C(text, 14, True, after=12)

    def muc_luc(self, muc, bang, hinh):
        self._tieu_de_dau("MỤC LỤC", ngat=False)
        for i, (lv, t) in enumerate(muc):
            self._dong_muc(t, lv, ("muc", t), first=(i == 0), last=(i == len(muc) - 1))
        self._tieu_de_dau("DANH MỤC BẢNG")
        for t in bang: self._dong_muc(t, 2, ("cap", t))
        self._tieu_de_dau("DANH MỤC HÌNH")
        for t in hinh: self._dong_muc(t, 2, ("cap", t))
        self._tieu_de_dau("DANH MỤC TỪ VIẾT TẮT")
        rows = [
            ("AIOps", "Artificial Intelligence for IT Operations", "Trí tuệ nhân tạo cho vận hành CNTT"),
            ("CI/CD", "Continuous Integration / Continuous Delivery", "Tích hợp / chuyển giao liên tục"),
            ("DORA", "DevOps Research and Assessment", "Bộ 4 chỉ số năng lực giao phần mềm"),
            ("GitOps", "Git-based Operations", "Vận hành hạ tầng/ứng dụng lấy Git làm nguồn sự thật"),
            ("IaC", "Infrastructure as Code", "Hạ tầng dưới dạng mã"),
            ("MCP", "Model Context Protocol", "Giao thức cấp công cụ/ngữ cảnh cho tác tử LLM"),
            ("MTTD / MTTR", "Mean Time To Detect / Restore", "Thời gian TB phát hiện / khôi phục"),
            ("RCA", "Root Cause Analysis", "Phân tích nguyên nhân gốc"),
            ("SBOM", "Software Bill of Materials", "Danh mục thành phần phần mềm"),
            ("SLI / SLO", "Service Level Indicator / Objective", "Chỉ số / mục tiêu mức dịch vụ"),
            ("SLSA", "Supply-chain Levels for Software Artifacts", "Khung bảo đảm chuỗi cung ứng phần mềm"),
            ("TMĐT", "E-commerce", "Thương mại điện tử"),
            ("VEX", "Vulnerability Exploitability eXchange", "Tuyên bố khả năng khai thác lỗ hổng"),
        ]
        t = self.d.add_table(rows=1 + len(rows), cols=3)
        t.style = "Table Grid"; t.alignment = WD_TABLE_ALIGNMENT.CENTER
        widths = [2.8, 6.8, 6.4]
        for ri, row in enumerate([("Từ viết tắt", "Tiếng Anh", "Ý nghĩa")] + rows):
            for ci, v in enumerate(row):
                c = t.rows[ri].cells[ci]; c.width = Cm(widths[ci])
                p = c.paragraphs[0]; p.paragraph_format.first_line_indent = Cm(0)
                p.paragraph_format.line_spacing = 1.1; p.paragraph_format.space_after = Pt(1)
                font_run(p.add_run(v), size=11, bold=(ri == 0 or ci == 0))
                if ri == 0: shade(c._tc.get_or_add_tcPr(), "D9E2F3")
        for gc, w in zip(t._tbl.tblGrid.findall(qn("w:gridCol")), widths):
            gc.set(qn("w:w"), str(int(w * 567)))


# ======================================================================= markdown → Word
TIEU_DE_CHUONG = re.compile(r"^#\s+(?:Chương\s+\d+\s*[—.\-:]\s*)?(.+?)\s*$")


# Trong repo, phần mở rộng là "Chương 8" và Kết luận là file 07; trong báo cáo, Kết luận không đánh số nên phần mở rộng
# thành CHƯƠNG 7 → đổi mọi tham chiếu mục 8.x → 7.x (chặn đầu để không chạm số phiên bản kiểu v0.8.13).
SO_MUC_8 = re.compile(r"(?<![\w.])8\.(\d{1,2}[a-z]?)(?![\d%×]|s\b|ms\b)")
# chỉ đổi số khớp ĐÚNG một mục có thật của chương mở rộng (## 8.N / ### 8.Nx) — không chạm giá trị như "8.0s", "8.5%"
MUC_8 = set(re.findall(r"^#{2,3}\s+8\.(\d{1,2}[a-z]?)\.", open(os.path.join(ROOT, "08-mo-rong-2026.md"), encoding="utf-8").read(), re.M))


def doi_so(line: str) -> str:
    line = SO_MUC_8.sub(lambda m: f"7.{m.group(1)}" if m.group(1) in MUC_8 else m.group(0), line)
    return re.sub(r"([Cc]hương) 8\b", r"\1 7", line)


def render_md(r: BaoCao, path: str, so_chuong=True, tham_khao: list | None = None):
    lines = [doi_so(l) for l in open(path, encoding="utf-8").read().splitlines()]
    i, para, mermaid_thay = 0, [], False

    def flush():
        if para:
            r.P(" ".join(s.strip() for s in para)); para.clear()

    while i < len(lines):
        ln = lines[i]
        if ln.startswith("# "):
            flush(); r.H1(TIEU_DE_CHUONG.match(ln).group(1), so_chuong=so_chuong); i += 1; continue
        if ln.startswith("## ") or ln.startswith("### "):
            flush()
            lv, text = (2, ln[3:].strip()) if ln.startswith("## ") else (3, ln[4:].strip())
            if text == "Tài liệu tham khảo" and tham_khao is not None:   # gom về mục cuối báo cáo
                i += 1
                while i < len(lines) and not lines[i].startswith("#"):
                    m = re.match(r"^\d+\.\s+(.*)", lines[i])
                    if m: tham_khao.append(m.group(1))
                    i += 1
                continue
            (r.H2 if lv == 2 else r.H3)(text)
            mermaid_thay = False
            for key, (img, cap) in HINH.items():
                if text.startswith(key) and os.path.exists(os.path.join(DIAG, img)):
                    r.IMG(os.path.join(DIAG, img), cap); mermaid_thay = True
            i += 1; continue
        if ln.startswith("#### "):
            flush(); r.H4(ln[5:].strip()); i += 1; continue
        if ln.startswith("```"):
            flush(); lang = ln[3:].strip(); i += 1; buf = []
            while i < len(lines) and not lines[i].startswith("```"):
                buf.append(lines[i]); i += 1
            i += 1
            if lang == "mermaid":
                if not mermaid_thay:
                    r.P("*(Sơ đồ Mermaid — xem bản render trong docs/thesis/diagrams.)*", indent=False)
                continue
            r.CODE("\n".join(buf), size=8.5); continue
        if ln.startswith("|"):
            flush(); rows = []
            while i < len(lines) and lines[i].startswith("|"):
                cells = [c.strip() for c in re.split(r"(?<!\\)\|", lines[i].strip().strip("|"))]
                if not all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c):
                    rows.append(cells)
                i += 1
            if rows:
                r.T(re.sub(r"^\d+(\.\d+)*\.\s*", "", md_inline(r.h_cuoi)).replace("`", "").strip(), rows[0], rows[1:])
            continue
        m = re.match(r"^(\s*)[-*]\s+(.*)", ln)
        if m:
            flush(); text = m.group(2); lvl = 2 if len(m.group(1)) >= 2 else 1; i += 1
            while i < len(lines) and lines[i].startswith(" " * (len(m.group(1)) + 2)) and not re.match(r"^\s*([-*]|\d+\.)\s+", lines[i]):
                text += " " + lines[i].strip(); i += 1
            r.B(text, lvl); continue
        m = re.match(r"^\s*(\d+)\.\s+(.*)", ln)
        if m:
            flush(); text = m.group(2); i += 1
            while i < len(lines) and lines[i].startswith("   ") and not re.match(r"^\s*([-*]|\d+\.)\s+", lines[i]):
                text += " " + lines[i].strip(); i += 1
            r.N(m.group(1), text); continue
        if ln.startswith(">"):
            flush(); r.QUOTE(ln.lstrip("> ").strip()); i += 1; continue
        if not ln.strip():
            flush(); i += 1; continue
        para.append(ln); i += 1
    flush()


def noi_dung(r: BaoCao):
    tham_khao: list[str] = []
    for f in CHUONG:
        render_md(r, os.path.join(ROOT, f), tham_khao=tham_khao)
    # Kết luận: không đánh số chương; tiêu đề cấp 1 cố định
    r.H1("KẾT LUẬN VÀ HƯỚNG PHÁT TRIỂN", so_chuong=False)
    r.chuong = 0; r.nb = 0; r.nh = 0
    lines = open(os.path.join(ROOT, KET_LUAN), encoding="utf-8").read().splitlines()
    tmp = os.path.join(tempfile.gettempdir() if not os.environ.get("TMPDIR") else os.environ["TMPDIR"], "kl.md")
    open(tmp, "w", encoding="utf-8").write("\n".join(l for l in lines if not l.startswith("# ")))
    render_md(r, tmp, so_chuong=False)
    r.H1("TÀI LIỆU THAM KHẢO", so_chuong=False)
    for k, t in enumerate(tham_khao, 1):
        p = r.d.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        p.paragraph_format.left_indent = Cm(0.9); p.paragraph_format.first_line_indent = Cm(-0.9)
        r._inline(p, f"[{k}]  {t}")
    r.H1("PHỤ LỤC. BÁO CÁO KIỂM THỬ TỰ ĐỘNG", so_chuong=False)
    tl = open(os.path.join(ROOT, "test-report.md"), encoding="utf-8").read().splitlines()
    open(tmp, "w", encoding="utf-8").write("\n".join(l for l in tl if not l.startswith("# ")))
    render_md(r, tmp, so_chuong=False)
    os.remove(tmp)


# ======================================================================= DỰNG + SỐ TRANG (giống mẫu)
def dung(trang, muc=None, bang=None, hinh=None):
    r = BaoCao(trang)
    r.bia()
    if muc is None:
        tmp = BaoCao({}); tmp.bia(); noi_dung(tmp)
        muc, bang, hinh = tmp.muc, tmp.bang, tmp.hinh
    r.muc_luc(muc, bang, hinh)
    noi_dung(r)
    for z in r.d.settings.element.findall(qn("w:zoom")):
        z.set(qn("w:percent"), "100")
    r.d.save(OUT)
    return r


def chuan_hoa(s):
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", md_inline(s).replace("`", "").replace("**", ""))).strip()


def lay_so_trang(r):
    td = tempfile.mkdtemp(dir=os.environ.get("TMPDIR"))
    subprocess.run(["soffice", "--headless", "--norestore", "--convert-to", "pdf", "--outdir", td, OUT],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    pdf = os.path.join(td, os.path.basename(OUT)[:-5] + ".pdf")
    txt = subprocess.run(["pdftotext", "-layout", pdf, "-"], capture_output=True, text=True).stdout
    pages = [chuan_hoa(p) for p in txt.split("\f")]
    start = next(i for i, p in enumerate(pages) if "DANH MỤC TỪ VIẾT TẮT" in p) + 1
    trang, cur = {}, start
    for _, t in r.muc:
        needle = chuan_hoa(t)[:50]
        for i in range(cur, len(pages)):
            if needle in pages[i]:
                trang[("muc", t)] = i + 1; cur = i; break
    for t in r.bang + r.hinh:
        needle = chuan_hoa(t)[:50]
        for i in range(start, len(pages)):
            if needle in pages[i]:
                trang[("cap", t)] = i + 1; break
    thieu = [t for _, t in r.muc if ("muc", t) not in trang] + [t for t in r.bang + r.hinh if ("cap", t) not in trang]
    return trang, thieu, len(pages) - 1, pdf


if __name__ == "__main__":
    r = dung({})
    trang, thieu, _, _ = lay_so_trang(r)
    r2 = dung(trang, r.muc, r.bang, r.hinh)
    trang2, thieu2, n, pdf = lay_so_trang(r2)
    if trang2 != trang:
        r2 = dung(trang2, r.muc, r.bang, r.hinh); trang2, thieu2, n, pdf = lay_so_trang(r2)
    print(f"Đã ghi {OUT} – {n} trang, {len(r2.bang)} bảng, {len(r2.hinh)} hình; PDF kiểm tra: {pdf}")
    if thieu2: print("Không tìm thấy trang cho:", thieu2[:20], "…" if len(thieu2) > 20 else "")
