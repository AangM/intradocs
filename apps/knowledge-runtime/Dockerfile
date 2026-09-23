FROM python:3.13.7-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 KNOWLEDGE_BIND=0.0.0.0
WORKDIR /app
# OCR for scanned PDF pages: Tesseract with Indonesian and English data, and pdftoppm to
# rasterise one page at a time. Local binaries only; the container still has no egress.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-ind tesseract-ocr-eng poppler-utils \
 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --no-create-home converter
COPY server.py convert.py ./
USER 10001:10001
EXPOSE 8091
CMD ["python", "-I", "server.py"]
