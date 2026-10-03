import hashlib
import re

SHA256_RE = re.compile(r'^[0-9a-f]{64}$')


def is_sha256(value):
    return bool(SHA256_RE.match(value or ''))


def sha256_file(path, block=4 * 1024 * 1024):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while True:
            b = f.read(block)
            if not b:
                break
            h.update(b)
    return h.hexdigest()
