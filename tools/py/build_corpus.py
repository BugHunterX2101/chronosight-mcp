"""Render corpus/encx14/pages/*.md to encx14.pdf and write manifest.json (DESIGN §16.2).

Usage: python tools/py/build_corpus.py [--check]

The pages are the source of truth. Each Markdown page becomes exactly one PDF
page, so a citation "page=31" opens at #page=31 in the viewer. The output is
byte-deterministic: no timestamps, no document ID, uncompressed streams, the
built-in Courier font with WinAnsiEncoding. --check rebuilds in memory and exits
non-zero if a committed output differs.

manifest.sha256 is the sha256 of the pages as the gateway serializes them into
the prompt prefix (P2): for each page in order, "<<doc=encx14 page=N>>\n" and
then the page text.
"""
from __future__ import annotations

import hashlib
import json
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CORPUS = ROOT / "corpus"
DOC_ID = "encx14"
TITLE = "EncoderX-14 Reference Manual"
VERSION = "1.2"
LICENCE = "CC-BY-4.0"
PAGES = 60

PAGE_W, PAGE_H = 612, 792  # US Letter, points
MARGIN_X, MARGIN_Y = 54, 54
FONT_SIZE, LEADING = 9.0, 11.0
MIN_FONT_SIZE = 5.0
CHAR_W = 0.6  # Courier advance width per point of font size
FOOTER_SIZE = 7.5


def read_pages(doc_dir: Path) -> list[str]:
    files = sorted((doc_dir / "pages").glob("*.md"))
    names = [f.name for f in files]
    expected = [f"{n:03d}.md" for n in range(1, PAGES + 1)]
    if names != expected:
        raise SystemExit(f"pages/ must hold exactly {expected[0]}..{expected[-1]}, found {names}")
    pages = []
    for f in files:
        raw = f.read_bytes()
        if b"\r" in raw:
            raise SystemExit(f"{f.name}: CR found, pages must use LF line endings")
        text = raw.decode("utf-8")
        if unicodedata.normalize("NFC", text) != text:
            raise SystemExit(f"{f.name}: text is not NFC")
        if not text.endswith("\n"):
            raise SystemExit(f"{f.name}: missing trailing newline")
        try:
            text.encode("cp1252")
        except UnicodeEncodeError as e:
            raise SystemExit(f"{f.name}: character {text[e.start]!r} is outside WinAnsiEncoding") from e
        pages.append(text)
    return pages


def corpus_sha256(pages: list[str]) -> str:
    h = hashlib.sha256()
    for n, text in enumerate(pages, 1):
        h.update(f"<<doc={DOC_ID} page={n}>>\n".encode())
        h.update(text.encode("utf-8"))
    return h.hexdigest()


def pdf_string(s: str) -> str:
    out = ["("]
    for b in s.encode("cp1252"):
        if b in (0x28, 0x29, 0x5C):  # ( ) backslash
            out.append("\\" + chr(b))
        elif b < 0x20 or b > 0x7E:
            out.append(f"\\{b:03o}")
        else:
            out.append(chr(b))
    return "".join(out) + ")"


def wrap(line: str, width: int) -> list[str]:
    if len(line) <= width:
        return [line]
    indent = " " * (len(line) - len(line.lstrip(" ")))
    rows, rest = [], line
    while len(rest) > width:
        cut = rest.rfind(" ", len(indent) + 1, width + 1)
        if cut <= len(indent):
            cut = width
        rows.append(rest[:cut].rstrip())
        rest = indent + rest[cut:].lstrip(" ")
    rows.append(rest)
    return rows


def num(x: float) -> str:
    return f"{x:.2f}".rstrip("0").rstrip(".")


def layout(text: str) -> tuple[float, float, list[str]]:
    """Wrap to the text width; shrink the font until the page fits on one PDF page."""
    body_h = PAGE_H - 2 * MARGIN_Y - 2 * LEADING  # leave room for the footer
    width = PAGE_W - 2 * MARGIN_X
    size = FONT_SIZE
    while True:
        leading = LEADING * size / FONT_SIZE
        cols = int(width // (CHAR_W * size))
        rows = [r for line in text.rstrip("\n").split("\n") for r in wrap(line, cols)]
        if len(rows) * leading <= body_h:
            return size, leading, rows
        if size <= MIN_FONT_SIZE:
            raise SystemExit(f"page has {len(rows)} lines and does not fit at {MIN_FONT_SIZE} pt")
        size -= 0.25


def page_stream(text: str, n: int) -> bytes:
    size, leading, rows = layout(text)
    # "'" moves to the next line before drawing, so start one line above the first baseline.
    top = PAGE_H - MARGIN_Y - size + leading
    ops = [f"BT /F1 {num(size)} Tf {num(leading)} TL {MARGIN_X} {num(top)} Td"]
    ops += [pdf_string(r) + " '" for r in rows]
    ops.append("ET")
    footer = f"ENCX14-RM rev {VERSION}    {LICENCE}    page {n} of {PAGES}"
    fx = (PAGE_W - len(footer) * CHAR_W * FOOTER_SIZE) / 2
    ops.append(f"BT /F1 {num(FOOTER_SIZE)} Tf {num(fx)} {MARGIN_Y - 18} Td {pdf_string(footer)} Tj ET")
    return ("\n".join(ops) + "\n").encode("latin-1")


def build_pdf(pages: list[str]) -> bytes:
    # Object numbers: 1 catalog, 2 pages, 3 font, 4 info, then a (page, content) pair per page.
    objs: dict[int, bytes] = {}
    kids = []
    for i, text in enumerate(pages):
        page_no, content_no = 5 + 2 * i, 6 + 2 * i
        kids.append(f"{page_no} 0 R")
        stream = page_stream(text, i + 1)
        objs[content_no] = f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"endstream"
        objs[page_no] = (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
                         f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content_no} 0 R >>").encode()
    objs[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objs[2] = f"<< /Type /Pages /Count {len(pages)} /Kids [{' '.join(kids)}] >>".encode()
    objs[3] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>"
    objs[4] = (f"<< /Title {pdf_string(f'{TITLE}, revision {VERSION}')} "
               f"/Subject {pdf_string(f'Licensed {LICENCE}')} >>").encode("latin-1")

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = {}
    for no in sorted(objs):
        offsets[no] = len(out)
        out += f"{no} 0 obj\n".encode() + objs[no] + b"\nendobj\n"
    xref = len(out)
    count = max(objs) + 1
    out += f"xref\n0 {count}\n0000000000 65535 f \n".encode()
    for no in range(1, count):
        out += f"{offsets[no]:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {count} /Root 1 0 R /Info 4 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def json_bytes(obj: object) -> bytes:
    return (json.dumps(obj, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def main() -> int:
    check = "--check" in sys.argv[1:]
    doc_dir = CORPUS / DOC_ID
    pages = read_pages(doc_dir)
    outputs = {
        doc_dir / f"{DOC_ID}.pdf": build_pdf(pages),
        doc_dir / "manifest.json": json_bytes({
            "docId": DOC_ID, "title": TITLE, "version": VERSION,
            "licence": LICENCE, "pages": PAGES, "sha256": corpus_sha256(pages),
        }),
    }
    vendor = CORPUS / "vendor-manifest.json"
    if not vendor.exists():  # hand-maintained once created, never overwritten
        outputs[vendor] = json_bytes({"documents": []})

    stale = [p for p, data in outputs.items() if not p.exists() or p.read_bytes() != data]
    if check:
        for p in stale:
            print(f"stale: {p.relative_to(ROOT).as_posix()}")
        return 1 if stale else 0
    for p in stale:
        p.write_bytes(outputs[p])
        print(f"wrote {p.relative_to(ROOT).as_posix()} ({len(outputs[p])} bytes)")
    if not stale:
        print("corpus up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main())
