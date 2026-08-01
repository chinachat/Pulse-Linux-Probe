#!/bin/sh
set -e
chown -R pulse:pulse /data 2>/dev/null || true
exec su-exec pulse python server.py
