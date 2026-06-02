"""nn_shot.py — drive the NN agent browser: navigate to a URL, wait, screenshot.
Usage: python tools/nn_shot.py <file-uri> <out.png>
"""
import sys, json, socket, base64, time

HOST, PORT = "127.0.0.1", 9785

def call(sock_file, obj):
    s = socket.create_connection((HOST, PORT), timeout=30)
    f = s.makefile("rwb")
    f.write((json.dumps(obj) + "\n").encode())
    f.flush()
    line = f.readline()
    s.close()
    return json.loads(line.decode())

def main():
    url = sys.argv[1]
    out = sys.argv[2]
    print("navigate:", call(None, {"action": "navigate", "url": url}).get("ok"))
    call(None, {"action": "wait", "ms": 1500})
    r = call(None, {"action": "screenshot"})
    if not r.get("ok"):
        print("screenshot failed:", r); return
    with open(out, "wb") as fh:
        fh.write(base64.b64decode(r["png_b64"]))
    print("saved", out, r.get("w"), r.get("h"))

if __name__ == "__main__":
    main()
