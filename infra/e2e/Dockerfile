# The browser test image: the official Playwright image (same version as
# @playwright/test in web/package.json) plus two tools:
#   certutil  to install the private CA in the browser's trust store, so the
#             tests use real HTTPS validation instead of "ignore certificate
#             errors";
#   ffmpeg    to synthesise reference audio for the tests (nothing downloaded).
FROM mcr.microsoft.com/playwright:v1.64.1-noble
RUN apt-get update \
 && apt-get install -y --no-install-recommends libnss3-tools ffmpeg \
 && rm -rf /var/lib/apt/lists/*
COPY trust-ca.sh /usr/local/bin/trust-ca
RUN chmod 755 /usr/local/bin/trust-ca
