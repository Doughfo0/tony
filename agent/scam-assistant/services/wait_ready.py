import sys
import time
import urllib.request

pending = set(sys.argv[1:])
deadline = time.monotonic() + 900

while pending and time.monotonic() < deadline:
    for url in list(pending):
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                if response.status == 200:
                    pending.remove(url)
                    print(f"Ready: {url}", flush=True)
        except Exception:
            pass
    if pending:
        time.sleep(5)

if pending:
    raise SystemExit(f"Services did not become ready: {sorted(pending)}")
