"""Bounded pipe-only text extraction. No archives are extracted to the filesystem."""
import io
import json
import re
import sys
import zipfile
from itertools import islice
from xml.etree import ElementTree as ET

MAX_INPUT = 8 * 1024 * 1024
MAX_XML = 2 * 1024 * 1024
MAX_TEXT = 30000
data = sys.stdin.buffer.read(MAX_INPUT + 1)
text = ""
status = "unsupported"
limited = False
try:
    if not data or len(data) > MAX_INPUT:
        raise ValueError("size")
    if sys.argv[1] == "pdf":
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data), strict=True)
        if reader.is_encrypted:
            raise ValueError("encrypted")
        limited = len(reader.pages) > 30
        parts = []
        total = 0
        for page in islice(reader.pages, 30):
            part = page.extract_text() or ""
            parts.append(part)
            total += len(part)
            if total > MAX_TEXT:
                break
        text = "\n".join(parts)
    elif sys.argv[1] == "office":
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = archive.namelist()
            if len(names) > 500:
                raise ValueError("entries")
            selected = [name for name in names if name == "word/document.xml" or name == "xl/sharedStrings.xml" or re.fullmatch(r"(?:xl/worksheets/sheet|ppt/slides/slide)\d+\.xml", name)][:30]
            limited = len([name for name in names if name == "word/document.xml" or name == "xl/sharedStrings.xml" or re.fullmatch(r"(?:xl/worksheets/sheet|ppt/slides/slide)\d+\.xml", name)]) > 30
            parts = []
            total = 0
            for name in selected:
                if archive.getinfo(name).file_size > MAX_XML:
                    raise ValueError("xml size")
                with archive.open(name) as source:
                    raw = source.read(MAX_XML + 1)
                if len(raw) > MAX_XML or b"<!DOCTYPE" in raw or b"<!ENTITY" in raw:
                    raise ValueError("xml")
                root = ET.fromstring(raw)
                part = "\n".join(node.text or "" for node in root.iter() if node.tag.rsplit("}", 1)[-1] in {"t", "v"})
                parts.append(part)
                total += len(part)
                if total > MAX_TEXT:
                    break
            text = "\n".join(parts)
    if text:
        status = "truncated" if limited or len(text) > MAX_TEXT else "complete"
except Exception:
    text = ""
    status = "unsupported"
sys.stdout.write(json.dumps({"text": text[:MAX_TEXT], "status": status}, ensure_ascii=False))
