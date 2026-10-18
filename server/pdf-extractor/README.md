# PDF text extraction companion

This private service extracts page-indexed text with pinned `pypdfium2` / PDFium. It accepts PDF bytes only: the authenticated gateway downloads public documents through its existing SSRF-safe, redirect-validated fetcher. The companion never fetches a URL. Do not publish its port to the internet.

Build with `docker build -t standard-red-notes/pdf-extractor:local server/pdf-extractor`. Run on the server's internal Docker network, with `--read-only --cap-drop ALL --security-opt no-new-privileges --memory 1200m --pids-limit 32`, and configure the gateway's `PDF_EXTRACTOR_URL` to the companion base URL (for example `http://pdf-extractor:8091`). No data volume is required. The runtime uses uid 65534 and no writable document files.

`POST /extract?startPage=1&endPage=10` accepts `Content-Type: application/pdf` and an explicit `Content-Length`. Page numbers are one-based. The JSON response contains `pageCount`, `pages: [{pageNumber,text}]`, `truncated`, and `scannedOrNoText`. Defaults are pages 1–10; requests may select at most 20 pages. The document is capped at 5 MiB and extracted output at 100,000 Unicode characters. Request another page range to continue reading.

Each parse runs in a separate subprocess, because PDFium is not thread-safe. A 20-second wall deadline kills and reaps stalled parsers. Linux workers also enforce 512 MiB address-space and 20 CPU-second limits. Two concurrent connections are accepted; excess connections receive 503. Socket reads time out after 10 seconds. The container memory limit remains necessary for the parent and both children. `/health` reports ready only after the native library has loaded at startup.

Scanned PDFs without a text layer return `scannedOrNoText: true`; OCR is not provided. Password-protected, damaged and unsupported documents fail with a closed extraction error. PDFium text extraction does not reconstruct tables or guarantee reading order. PDF JavaScript/XFA builds are not installed.

Tests: create an isolated Python 3.12 virtual environment, install `requirements.txt`, then run `python -m unittest discover -s server/pdf-extractor -v`. The suite generates a real tiny PDF, exercises PDFium in a subprocess and over HTTP, and checks bounds and timeout wiring.

References: [PDFium Python API](https://pypdfium2.readthedocs.io/en/stable/python_api.html), [pypdfium2 installation and threading notes](https://pypdfium2.readthedocs.io/en/stable/python_api.html#thread-incompatibility), [pinned package](https://pypi.org/project/pypdfium2/5.14.0/).
