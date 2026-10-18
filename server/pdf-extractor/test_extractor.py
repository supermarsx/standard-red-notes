import http.client
import json
import subprocess
import threading
import unittest
from unittest.mock import patch

import extractor


def tiny_pdf(text="Hello PDFium"):
    stream = f"BT /F1 18 Tf 40 150 Td ({text}) Tj ET".encode()
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>",
               b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
               b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"]
    data = b"%PDF-1.4\n"
    offsets = [0]
    for number, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data += f"{number} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(data)
    data += b"xref\n0 6\n0000000000 65535 f \n"
    data += b"".join(f"{offset:010} 00000 n \n".encode() for offset in offsets[1:])
    data += f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode()
    return data


class ExtractionTests(unittest.TestCase):
    def test_real_pdfium_in_separate_process(self):
        result = extractor.run_isolated(tiny_pdf(), 1, 10)
        self.assertEqual(result["pageCount"], 1)
        self.assertEqual(result["pages"], [{"pageNumber": 1, "text": "Hello PDFium"}])
        self.assertFalse(result["scannedOrNoText"])

    def test_empty_text_explicit(self):
        self.assertTrue(extractor.extract(tiny_pdf(""), 1, 1)["scannedOrNoText"])

    def test_text_cap(self):
        with patch.object(extractor, "MAX_CHARS", 5):
            result = extractor.extract(tiny_pdf(), 1, 1)
        self.assertEqual(result["pages"][0]["text"], "Hello")
        self.assertTrue(result["truncated"])

    def test_reject_page_outside_document(self):
        with self.assertRaisesRegex(ValueError, "PAGE_OUT_OF_RANGE"):
            extractor.extract(tiny_pdf(), 2, 3)

    def test_invalid_document(self):
        with self.assertRaises(ValueError):
            extractor.extract(b"<html>not pdf</html>", 1, 1)

    def test_range_bound(self):
        with self.assertRaisesRegex(ValueError, "INVALID_PAGE_RANGE"):
            extractor.extract(tiny_pdf(), 1, 21)

    def test_native_timeout_enforced(self):
        with patch.object(extractor.subprocess, "run", side_effect=subprocess.TimeoutExpired("worker", 20)) as run:
            with self.assertRaises(subprocess.TimeoutExpired):
                extractor.run_isolated(tiny_pdf(), 1, 1)
            self.assertEqual(run.call_args.kwargs["timeout"], 20)


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = extractor.Server(("127.0.0.1", 0), extractor.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        try:
            connection.request(method, path, body, headers or {})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_health(self):
        self.assertEqual(self.request("GET", "/health")[0], 200)

    def test_real_post(self):
        status, result = self.request("POST", "/extract?startPage=1&endPage=1", tiny_pdf(), {"Content-Type": "application/pdf"})
        self.assertEqual(status, 200)
        self.assertEqual(result["pages"][0]["text"], "Hello PDFium")

    def test_reject_url_json(self):
        self.assertEqual(self.request("POST", "/extract", '{"url":"http://localhost"}', {"Content-Type": "application/json"})[0], 415)

    def test_reject_large_length_without_reading_body(self):
        self.assertEqual(self.request("POST", "/extract", b"", {"Content-Type": "application/pdf", "Content-Length": str(extractor.MAX_BYTES + 1)})[0], 400)


if __name__ == "__main__":
    unittest.main()
