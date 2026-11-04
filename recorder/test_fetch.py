import urllib.error
import urllib.request

import pytest

from fetch import SafeRedirect


@pytest.mark.parametrize("url", ["http://example.com/x", "https://169.254.169.254/latest", "https://localhost/x", "https://10.0.0.1/"])
def test_redirects_to_internal_or_plain_http_are_refused(url):
    with pytest.raises(urllib.error.HTTPError):
        SafeRedirect().redirect_request(urllib.request.Request("https://whattomine.com/coins.json"), None, 302, "Found", {}, url)


def test_public_name_resolving_inside_is_refused(monkeypatch):
    monkeypatch.setattr("socket.getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("10.0.0.5", 443))])
    with pytest.raises(urllib.error.HTTPError):
        SafeRedirect().redirect_request(urllib.request.Request("https://whattomine.com/coins.json"), None, 302, "Found", {},
                                        "https://rebind.example.com/x")


def test_public_https_redirect_is_followed(monkeypatch):
    monkeypatch.setattr("socket.getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("104.21.1.1", 443))])
    req = SafeRedirect().redirect_request(urllib.request.Request("https://whattomine.com/coins.json"), None, 302, "Found", {},
                                          "https://www.whattomine.com/coins.json")
    assert req.full_url == "https://www.whattomine.com/coins.json"


def test_token_only_goes_to_github():
    from main import gh

    with pytest.raises(ValueError):
        gh("POST", "https://evil.example/upload", "TOKEN", data=b"x")
