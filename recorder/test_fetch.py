import urllib.error
import urllib.request

import pytest

from fetch import SafeRedirect


@pytest.mark.parametrize("url", ["http://example.com/x", "https://169.254.169.254/latest", "https://localhost/x", "https://10.0.0.1/"])
def test_redirects_to_internal_or_plain_http_are_refused(url):
    with pytest.raises(urllib.error.HTTPError):
        SafeRedirect().redirect_request(urllib.request.Request("https://api.github.com/x"), None, 302, "Found", {}, url)


def test_public_name_resolving_inside_is_refused(monkeypatch):
    monkeypatch.setattr("socket.getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("10.0.0.5", 443))])
    with pytest.raises(urllib.error.HTTPError):
        SafeRedirect().redirect_request(urllib.request.Request("https://api.github.com/x"), None, 302, "Found", {},
                                        "https://rebind.example.com/x")


def test_public_https_redirect_is_followed(monkeypatch):
    monkeypatch.setattr("socket.getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("104.21.1.1", 443))])
    req = SafeRedirect().redirect_request(urllib.request.Request("https://api.github.com/x"), None, 302, "Found", {},
                                          "https://github.com/x")
    assert req.full_url == "https://github.com/x"


def test_token_only_goes_to_github():
    from main import gh

    with pytest.raises(ValueError):
        gh("POST", "https://evil.example/upload", "TOKEN", data=b"x")


def test_exists_is_false_on_any_github_error(monkeypatch):
    import main

    def boom(*a, **k):
        raise urllib.error.HTTPError("u", 403, "Forbidden", {}, None)

    monkeypatch.setattr(main, "gh", boom)
    assert main.exists("o/r", "site-data/benchmarks.json", "TOKEN") is False


def test_sources_whose_terms_forbid_collection_are_not_fetched(monkeypatch):
    import json, os
    from datetime import datetime, timezone
    import fetch

    calls = []
    monkeypatch.setattr(fetch, "get", lambda url, body=None, timeout=40: calls.append(url) or {})
    monkeypatch.setattr(fetch, "bittensor_metagraphs", lambda: [])
    tables = json.load(open(os.path.join(os.path.dirname(__file__), "..", "tables.json")))
    public, private = fetch.fetch_all(tables, datetime(2026, 11, 4, tzinfo=timezone.utc), daily=False)
    assert "vast" not in public and "runpod" not in public
    assert not any("vast.ai" in u or "runpod" in u for u in calls)
    assert "clore" in public
