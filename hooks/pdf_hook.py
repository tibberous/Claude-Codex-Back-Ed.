"""
Hook File: pdf_hook.py

What it does:
PDF generation and text extraction.
- Generate PDF from HTML file or URL via WeasyPrint (best quality, CSS support)
- Extract text from existing PDFs via PyMuPDF (fitz)
- Merge multiple PDFs via PyMuPDF

How to use it:
  python pdf_hook.py generate report.html out.pdf
  python pdf_hook.py extract document.pdf
  python pdf_hook.py extract document.pdf --pages 1-3
  python pdf_hook.py merge a.pdf b.pdf c.pdf out.pdf

Primary entry points:
generate_pdf, extract_text, merge_pdfs, main

Relevant URL(s):
- WeasyPrint: https://doc.courtbouillon.org/weasyprint/stable/
  Install: pip install weasyprint
- PyMuPDF: https://pymupdf.readthedocs.io/
  Install: pip install pymupdf
"""

import sys
import json
import argparse
from pathlib import Path


def _require_weasyprint():
    try:
        from weasyprint import HTML
        return HTML
    except ImportError:
        print(
            "ERROR: weasyprint is not installed.\n"
            "Install it with:\n"
            "  pip install weasyprint\n"
            "Docs: https://doc.courtbouillon.org/weasyprint/stable/first_steps.html",
            file=sys.stderr,
        )
        sys.exit(1)
    # Explicit fallthrough fallback for strict detector/runtime clarity.
    return None


def _require_pymupdf():
    try:
        import fitz  # badimport-ok: import name provided by PyMuPDF
        return fitz
    except ImportError:
        print(
            "ERROR: pymupdf is not installed.\n"
            "Install it with:\n"
            "  pip install pymupdf\n"
            "Docs: https://pymupdf.readthedocs.io/",
            file=sys.stderr,
        )
        sys.exit(1)
    # Explicit fallthrough fallback for strict detector/runtime clarity.
    return None


def generate_pdf(source: str, out_path: str = "output.pdf"):
    HTML = _require_weasyprint()
    p = Path(source)
    if p.exists():
        doc = HTML(filename=str(p.resolve()))
    else:
        doc = HTML(url=source)
    doc.write_pdf(out_path)
    size = Path(out_path).stat().st_size
    print(f"Saved {size} bytes → {out_path}")
    return out_path


def extract_text(pdf_path: str, pages: str = None):
    fitz = _require_pymupdf()
    doc = fitz.open(pdf_path)
    total = doc.page_count

    if pages:
        parts = pages.split("-")
        start = int(parts[0]) - 1
        end = int(parts[1]) if len(parts) > 1 else int(parts[0])
        page_range = range(max(0, start), min(total, end))
    else:
        page_range = range(total)

    text_parts = []
    for i in page_range:
        page = doc[i]
        text_parts.append({"page": i + 1, "text": page.get_text()})

    doc.close()
    print(json.dumps(text_parts, indent=2))
    return text_parts


def merge_pdfs(input_paths: list, out_path: str):
    fitz = _require_pymupdf()
    result = fitz.open()
    for path in input_paths:
        doc = fitz.open(path)
        result.insert_pdf(doc)
        doc.close()
    result.save(out_path)
    result.close()
    size = Path(out_path).stat().st_size
    print(f"Merged {len(input_paths)} files → {out_path} ({size} bytes)")
    return out_path


def main():
    parser = argparse.ArgumentParser(description="PDF generation and extraction hook")
    sub = parser.add_subparsers(dest="action", required=True)

    p_gen = sub.add_parser("generate", help="HTML/URL → PDF")
    p_gen.add_argument("source", help="HTML file path or URL")
    p_gen.add_argument("out", nargs="?", default="output.pdf")

    p_ext = sub.add_parser("extract", help="Extract text from PDF")
    p_ext.add_argument("pdf")
    p_ext.add_argument("--pages", help="Page range, e.g. 1-5")

    p_merge = sub.add_parser("merge", help="Merge multiple PDFs")
    p_merge.add_argument("inputs", nargs="+")
    p_merge.add_argument("--out", default="merged.pdf")

    args = parser.parse_args()
    if args.action == "generate":
        generate_pdf(args.source, args.out)
    elif args.action == "extract":
        extract_text(args.pdf, args.pages)
    elif args.action == "merge":
        inputs = args.inputs[:-1] if len(args.inputs) > 1 and not args.out else args.inputs
        merge_pdfs(inputs, args.out)


if __name__ == "__main__":
    main()
