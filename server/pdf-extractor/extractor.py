"""Private PDFium text extraction. Never fetches URLs or executes PDF scripts."""
import json
import os
import subprocess
import sys
import threading
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

MAX_BYTES = 5 * 1024 * 1024
MAX_PAGES = 20
MAX_CHARS = 100_000
TIMEOUT = 20


def extract(data, start, end, pdfium=None):
    if not data.startswith(b"%PDF-") or len(data) > MAX_BYTES:
        raise ValueError("INVALID_PDF")
    if not 1 <= start <= end or end - start + 1 > MAX_PAGES:
        raise ValueError("INVALID_PAGE_RANGE")
    if pdfium is None:
        import pypdfium2 as pdfium
    pages = []
    remaining = MAX_CHARS
    truncated = False
    with closing(pdfium.PdfDocument(data)) as document:
        page_count = len(document)
        if start > page_count:
            raise ValueError("PAGE_OUT_OF_RANGE")
        for index in range(start - 1, min(end, page_count)):
            with closing(document[index]) as page, closing(page.get_textpage()) as textpage:
                count = textpage.count_chars()
                limit = min(count, remaining)
                text = textpage.get_text_range(0, limit) if limit else ""
                text = text.replace("\r\n", "\n")[:remaining]
                pages.append({"pageNumber": index + 1, "text": text})
                remaining -= len(text)
                truncated = truncated or count > limit
            if remaining == 0:
                truncated = truncated or index + 1 < min(end, page_count)
                break
    return {"pages": pages, "pageCount": page_count, "truncated": truncated,
            "scannedOrNoText": not any(page["text"].strip() for page in pages)}


def run_isolated(data, start, end):
    # Separate process: PDFium is not thread-safe, and native parsing must have
    # a hard deadline. subprocess.run kills and reaps children on timeout.
    result = subprocess.run([sys.executable, __file__, "--worker", str(start), str(end)],
                            input=data, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=TIMEOUT, check=False)
    if result.returncode != 0:
        raise ValueError("PDF_EXTRACTION_FAILED")
    return json.loads(result.stdout)


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *_args):
        pass  # No document bytes, query strings or user URLs in logs.

    def reply(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.reply(200 if self.path == "/health" else 404,
                   {"status": "ready"} if self.path == "/health" else {"error": "NOT_FOUND"})

    def do_POST(self):
        if urlsplit(self.path).path != "/extract":
            return self.reply(404, {"error": "NOT_FOUND"})
        if self.headers.get_content_type() != "application/pdf":
            return self.reply(415, {"error": "PDF_REQUIRED"})
        try:
            if self.headers.get("Transfer-Encoding"):
                raise ValueError()
            length = int(self.headers.get("Content-Length", "0"))
            query = parse_qs(urlsplit(self.path).query)
            start = int(query.get("startPage", ["1"])[0])
            end = int(query.get("endPage", [str(start + 9)])[0])
            if not 0 < length <= MAX_BYTES or not 1 <= start <= end or end - start + 1 > MAX_PAGES:
                raise ValueError()
        except ValueError:
            return self.reply(400, {"error": "INVALID_REQUEST"})
        try:
            data = self.rfile.read(length)
            if len(data) != length:
                raise ValueError()
            self.reply(200, run_isolated(data, start, end))
        except subprocess.TimeoutExpired:
            self.reply(504, {"error": "PDF_EXTRACTION_TIMEOUT"})
        except (ValueError, OSError):
            self.reply(422, {"error": "PDF_EXTRACTION_FAILED"})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # Bound connections before creating threads, including slow upload clients.
    slots = threading.BoundedSemaphore(2)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            try:
                request.settimeout(1)
                request.sendall(b"HTTP/1.0 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        # Linux companion imposes per-parser memory/CPU limits as well as wall time.
        if sys.platform == "linux":
            import resource
            resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
            resource.setrlimit(resource.RLIMIT_CPU, (TIMEOUT,) * 2)
        try:
            print(json.dumps(extract(sys.stdin.buffer.read(MAX_BYTES + 1), int(sys.argv[2]), int(sys.argv[3]))))
        except Exception:
            sys.exit(1)
    else:
        import pypdfium2  # Fail boot/health if the native dependency cannot load.
        Server(("0.0.0.0", int(os.environ.get("PORT", "8091"))), Handler).serve_forever()
