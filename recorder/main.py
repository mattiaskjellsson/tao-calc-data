"""One hourly run: fetch, archive raw snapshots to GitHub Releases, commit the reduced site data."""
import base64
import gzip
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from fetch import fetch_all
from reduce import benchmarks, reduce

API = "https://api.github.com"
HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC_REPO = os.environ.get("PUBLIC_REPO", "mattiaskjellsson/tao-calc-data")
PRIVATE_REPO = os.environ.get("PRIVATE_REPO", "mattiaskjellsson/tao-calc-data-private")
DRY_RUN = os.environ.get("DRY_RUN") == "1"
OUT = os.path.join(HERE, "out")


def asset_name(now: datetime) -> tuple[str, str]:
    return f"data-{now:%Y-%m}", f"{now:%Y-%m-%dT%H}Z.json.gz"


def gh(method: str, path: str, token: str, body=None, data: bytes | None = None, ctype: str = "application/json"):
    payload = data if data is not None else (json.dumps(body).encode() if body is not None else None)
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "tao-calc-recorder"}
    if payload is not None:
        headers["Content-Type"] = ctype
    url = path if path.startswith("http") else API + path
    if not url.startswith(("https://api.github.com/", "https://uploads.github.com/")):
        raise ValueError(f"refusing to send the token to {urllib.parse.urlsplit(url).hostname}")
    req = urllib.request.Request(url, data=payload, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=300) as r:
        raw = r.read()
        return json.loads(raw) if raw else {}


def get_file(repo: str, path: str, token: str) -> tuple[bytes | None, str | None]:
    try:
        f = gh("GET", f"/repos/{repo}/contents/{path}", token)
        return base64.b64decode(f["content"]), f["sha"]
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None, None
        raise


def exists(repo: str, path: str, token: str) -> bool:
    try:
        return get_file(repo, path, token)[1] is not None
    except Exception:  # no access yet (e.g. the token doesn't cover this repo) counts as missing
        return False


def put_file(repo: str, path: str, data: bytes, msg: str, token: str) -> None:
    _, sha = get_file(repo, path, token)
    body = {"message": msg, "content": base64.b64encode(data).decode()} | ({"sha": sha} if sha else {})
    gh("PUT", f"/repos/{repo}/contents/{path}", token, body)


def ensure_release(repo: str, tag: str, token: str) -> dict:
    try:
        return gh("GET", f"/repos/{repo}/releases/tags/{tag}", token)
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
    if get_file(repo, "README.md", token)[1] is None:  # a release needs a commit to tag; an empty repo has none
        put_file(repo, "README.md", b"# Hourly raw snapshots\n\nOne release per month, one gzipped JSON per hour.\n",
                 "Add README", token)
    return gh("POST", f"/repos/{repo}/releases", token,
              {"tag_name": tag, "name": tag, "body": "Hourly raw snapshots, one gzipped JSON per hour. See the README."})


def upload(repo: str, tag: str, name: str, gz: bytes, token: str) -> str:
    rel = ensure_release(repo, tag, token)
    try:
        gh("POST", rel["upload_url"].split("{")[0] + f"?name={name}", token, data=gz, ctype="application/gzip")
        return "uploaded"
    except urllib.error.HTTPError as e:
        if e.code == 422:  # already uploaded this hour (a re-run)
            return "exists"
        raise


def write(rel_path: str, data: bytes) -> None:
    path = os.path.join(OUT, rel_path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def snapshot(now: datetime, sources: dict) -> bytes:
    return gzip.compress(json.dumps({"ts": now.isoformat(), "sources": sources}, default=str).encode())


def split_snapshot(sources: dict, publish_raw: list[str]) -> tuple[dict, dict]:
    """Raw data goes public only for sources whose terms allow it; the rest is kept in the private archive."""
    return ({k: v for k, v in sources.items() if k in publish_raw},
            {k: v for k, v in sources.items() if k not in publish_raw})


def main() -> int:
    token = os.environ.get("GITHUB_REPO_DATA_KEY", "")
    if not token and not DRY_RUN:
        print("GITHUB_REPO_DATA_KEY is not set", file=sys.stderr)
        return 1
    tables = json.load(open(os.path.join(HERE, "..", "tables.json")))
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    tag, name = asset_name(now)
    failures = []

    def step(label, fn):
        try:
            print(f"{label}: {fn() or 'ok'}", flush=True)
        except Exception as e:  # urllib errors carry no headers, so the token never reaches the log
            failures.append(label)
            print(f"{label}: FAILED {e!r}"[:500], file=sys.stderr, flush=True)

    if DRY_RUN:
        have_bench = os.path.exists(os.path.join(OUT, "site-data", "benchmarks.json"))
    else:
        have_bench = exists(PUBLIC_REPO, "site-data/benchmarks.json", token)
    public, private = fetch_all(tables, now, daily=now.hour == 0 or not have_bench)
    errors = [k for k, v in public.items() if isinstance(v, dict) and "error" in v]
    print(f"fetched: {len(public)} public sources, errors: {errors or 'none'}", flush=True)

    open_raw, held_raw = split_snapshot(public, tables["publish_raw"])
    pub_gz, priv_gz = snapshot(now, open_raw), snapshot(now, held_raw | private)
    latest = json.dumps(reduce(public, tables, now), separators=(",", ":"), allow_nan=False).encode()
    bench = benchmarks(public["nicehash_devices"]["devices"], tables, now) \
        if isinstance(public.get("nicehash_devices"), dict) and "devices" in public["nicehash_devices"] else None

    if DRY_RUN:
        write(f"public/{tag}/{name}", pub_gz)
        write(f"private/{tag}/{name}", priv_gz)
        write("site-data/latest.json", latest)
        write(f"site-data/daily/{now:%Y-%m-%d}.json", latest)
        if bench:
            write("site-data/benchmarks.json", json.dumps(bench, separators=(",", ":")).encode())
        print(f"dry run: public {len(pub_gz)} B, private {len(priv_gz)} B, latest {len(latest)} B")
        return 0

    step("public snapshot", lambda: upload(PUBLIC_REPO, tag, name, pub_gz, token))
    step("private snapshot", lambda: upload(PRIVATE_REPO, tag, name, priv_gz, token))
    step("latest.json", lambda: put_file(PUBLIC_REPO, "site-data/latest.json", latest, f"data: {now:%Y-%m-%d %H}Z", token))
    daily_path = f"site-data/daily/{now:%Y-%m-%d}.json"
    step("daily", lambda: "exists" if exists(PUBLIC_REPO, daily_path, token)
         else put_file(PUBLIC_REPO, daily_path, latest, f"data: daily {now:%Y-%m-%d}", token))
    if bench:
        def bench_step():
            old, _ = get_file(PUBLIC_REPO, "site-data/benchmarks.json", token)
            if old and json.loads(old)["gpus"] == bench["gpus"]:
                return "unchanged"
            put_file(PUBLIC_REPO, "site-data/benchmarks.json", json.dumps(bench, separators=(",", ":")).encode(),
                     "data: benchmarks", token)
        step("benchmarks", bench_step)
    print(f"done, failures: {failures or 'none'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
