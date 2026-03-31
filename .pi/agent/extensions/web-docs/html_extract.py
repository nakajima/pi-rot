#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
import sys
from html.parser import HTMLParser
from typing import Dict, List, Optional
from urllib.parse import urlparse

BLOCK_TAGS = {
    "p",
    "div",
    "section",
    "article",
    "ul",
    "ol",
    "li",
    "table",
    "tr",
    "blockquote",
    "aside",
    "main",
    "details",
    "summary",
    "dl",
    "dt",
    "dd",
    "pre",
    "br",
}

IGNORE_TAGS = {
    "script",
    "style",
    "noscript",
    "svg",
    "canvas",
    "iframe",
    "template",
}

INLINE_SKIP_CLASSES = {
    "nav",
    "menu",
    "sidebar",
    "breadcrumb",
    "breadcrumbs",
    "toc",
    "table-of-contents",
    "cookie",
    "cookies",
    "footer",
    "header",
}


def normalize_space(value: str) -> str:
    value = value.replace("\u00a0", " ")
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def normalize_multiline(value: str) -> str:
    value = value.replace("\r\n", "\n")
    value = value.replace("\u00a0", " ")
    value = re.sub(r"[ \t]+\n", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


class DocParser(HTMLParser):
    def __init__(self, url: str):
        super().__init__(convert_charrefs=True)
        self.url = url
        self.title_parts: List[str] = []
        self.description = ""
        self.in_title = False
        self.ignore_depth = 0
        self.in_heading = False
        self.current_heading_level = 0
        self.current_heading_id: Optional[str] = None
        self.current_heading_parts: List[str] = []
        self.current_text_parts: List[str] = []
        self.current_code_parts: List[str] = []
        self.current_code_is_block = False
        self.in_code = False
        self.in_pre = False
        self.list_stack: List[str] = []
        self.sections: List[Dict[str, object]] = []
        self.current_section: Dict[str, object] = {
            "heading": "Overview",
            "level": 0,
            "id": None,
            "parts": [],
            "codeBlocks": [],
        }
        self.page_text_parts: List[str] = []

    def handle_starttag(self, tag: str, attrs: List[tuple[str, Optional[str]]]):
        attrs_dict = {key.lower(): (value or "") for key, value in attrs}
        class_blob = " ".join(
            [attrs_dict.get("class", ""), attrs_dict.get("id", ""), attrs_dict.get("role", "")]
        ).lower()

        if tag in IGNORE_TAGS or tag in {"nav", "header", "footer", "aside"}:
            self.ignore_depth += 1
            return

        if any(token in class_blob for token in INLINE_SKIP_CLASSES) and tag in {"div", "nav", "aside", "header", "footer", "ul", "ol"}:
            self.ignore_depth += 1
            return

        if tag == "title":
            self.in_title = True
            return

        if self.ignore_depth > 0:
            return

        if tag in {"meta"}:
            name = attrs_dict.get("name", "").lower()
            prop = attrs_dict.get("property", "").lower()
            if not self.description and (name == "description" or prop == "og:description"):
                self.description = normalize_space(attrs_dict.get("content", ""))
            return

        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self._flush_text_paragraph(force=True)
            self._flush_code_block(force=True)
            self._finish_section()
            self.in_heading = True
            self.current_heading_level = int(tag[1])
            self.current_heading_id = attrs_dict.get("id") or attrs_dict.get("data-anchor") or None
            self.current_heading_parts = []
            return

        if tag == "pre":
            self._flush_text_paragraph(force=True)
            self.in_pre = True
            self.in_code = True
            self.current_code_is_block = True
            return

        if tag == "code":
            self.in_code = True
            if self.in_pre:
                self.current_code_is_block = True
            return

        if tag in {"ul", "ol"}:
            self.list_stack.append(tag)
            return

        if tag == "li":
            self.current_text_parts.append("\n- ")
            return

        if tag == "br":
            self.current_text_parts.append("\n")
            return

    def handle_endtag(self, tag: str):
        if tag in IGNORE_TAGS:
            if self.ignore_depth > 0:
                self.ignore_depth -= 1
            return

        if self.in_title and tag == "title":
            self.in_title = False
            return

        if self.ignore_depth > 0:
            if tag in {"div", "nav", "aside", "header", "footer", "ul", "ol"}:
                self.ignore_depth = max(0, self.ignore_depth - 1)
            return

        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"} and self.in_heading:
            heading = normalize_space("".join(self.current_heading_parts))
            self.current_section = {
                "heading": heading or "Untitled section",
                "level": self.current_heading_level,
                "id": self.current_heading_id,
                "parts": [],
                "codeBlocks": [],
            }
            self.page_text_parts.append((heading or "Untitled section") + "\n")
            self.in_heading = False
            self.current_heading_level = 0
            self.current_heading_id = None
            self.current_heading_parts = []
            return

        if tag == "pre":
            self._flush_code_block(force=True)
            self.in_pre = False
            self.in_code = False
            self.current_code_is_block = False
            return

        if tag == "code":
            if not self.in_pre:
                self.in_code = False
                self._flush_inline_code()
            return

        if tag in BLOCK_TAGS:
            self._flush_text_paragraph(force=True)
            return

        if tag in {"ul", "ol"} and self.list_stack:
            self.list_stack.pop()
            self._flush_text_paragraph(force=True)
            return

    def handle_data(self, data: str):
        if not data:
            return
        if self.in_title:
            self.title_parts.append(data)
            return
        if self.ignore_depth > 0:
            return
        if self.in_heading:
            self.current_heading_parts.append(data)
            return
        if self.in_code:
            self.current_code_parts.append(data)
            return
        self.current_text_parts.append(data)

    def _flush_inline_code(self):
        if not self.current_code_parts:
            return
        code = normalize_space("".join(self.current_code_parts))
        self.current_code_parts = []
        if code:
            self.current_text_parts.append(f" `{code}` ")

    def _flush_code_block(self, force: bool = False):
        if not force and not self.current_code_is_block:
            return
        if not self.current_code_parts:
            return
        code = "".join(self.current_code_parts)
        self.current_code_parts = []
        code = code.replace("\r\n", "\n").strip("\n")
        if not code:
            return
        block = f"```\n{code}\n```"
        self.current_section.setdefault("codeBlocks", []).append(code)
        self.current_section.setdefault("parts", []).append(block)
        self.page_text_parts.append(block + "\n\n")

    def _flush_text_paragraph(self, force: bool = False):
        if not self.current_text_parts:
            return
        text = "".join(self.current_text_parts)
        self.current_text_parts = []
        if not force and not text.strip():
            return
        text = normalize_multiline(text)
        if not text:
            return
        self.current_section.setdefault("parts", []).append(text)
        self.page_text_parts.append(text + "\n\n")

    def _finish_section(self):
        parts = [normalize_multiline(str(part)) for part in self.current_section.get("parts", []) if normalize_multiline(str(part))]
        code_blocks = [normalize_multiline(str(block)) for block in self.current_section.get("codeBlocks", []) if normalize_multiline(str(block))]
        heading = normalize_space(str(self.current_section.get("heading", "")))
        level = int(self.current_section.get("level", 0) or 0)
        section_id = self.current_section.get("id")
        if heading or parts or code_blocks:
            self.sections.append(
                {
                    "heading": heading,
                    "level": level,
                    "id": section_id or None,
                    "content": normalize_multiline("\n\n".join(parts)),
                    "codeBlocks": code_blocks,
                }
            )

    def finish(self) -> Dict[str, object]:
        self._flush_text_paragraph(force=True)
        self._flush_code_block(force=True)
        self._finish_section()
        title = normalize_space("".join(self.title_parts))
        if not title:
            parsed = urlparse(self.url)
            title = parsed.netloc + parsed.path
        markdown_lines: List[str] = []
        if title:
            markdown_lines.append(f"# {title}")
            markdown_lines.append("")
        if self.description:
            markdown_lines.append(self.description)
            markdown_lines.append("")
        for section in self.sections:
            heading = str(section.get("heading", "")).strip()
            level = int(section.get("level", 0) or 0)
            content = normalize_multiline(str(section.get("content", "")))
            if level > 0 and heading:
                markdown_lines.append(f"{'#' * max(2, min(6, level + 1))} {heading}")
                markdown_lines.append("")
            if content:
                markdown_lines.append(content)
                markdown_lines.append("")
        markdown = normalize_multiline("\n".join(markdown_lines))
        text = normalize_multiline("".join(self.page_text_parts))
        return {
            "title": title,
            "description": self.description,
            "markdown": markdown,
            "text": text,
            "sections": self.sections,
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="", help="Source URL for fallback title generation")
    args = parser.parse_args()

    html = sys.stdin.read()
    doc_parser = DocParser(args.url)
    doc_parser.feed(html)
    payload = doc_parser.finish()
    json.dump(payload, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
