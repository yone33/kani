"""Local portfolio server. Only stock codes are sent to Yahoo! Finance."""
import argparse
import calendar
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from html import unescape
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
from threading import Lock
from time import monotonic
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
import webbrowser

ROOT = Path(__file__).resolve().parent / "web"
YAHOO = "https://finance.yahoo.co.jp/quote/"
CODE = re.compile(r"[0-9A-Z]{4}")
CACHE = {}
LOCK = Lock()
POOL = ThreadPoolExecutor(max_workers=8)


def plain(markup):
    return " ".join(unescape(re.sub(r"<[^>]+>", "", markup)).split())


def capture(pattern, page):
    match = re.search(pattern, page, re.S)
    return match.group(1) if match else ""


def number(text):
    text = plain(text).replace(",", "").removesuffix("円").strip()
    return float(text) if re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", text) else None


def period_end(year, month):
    year, month = year + (month - 1) // 12, (month - 1) % 12 + 1
    return f"{year:04d}-{month:02d}-{calendar.monthrange(year, month)[1]:02d}"


def dividends(page):
    tables = re.findall(r'<table class="[^"]*DpsHistoryTable__table"[^>]*>(.*?)</table>', page, re.S)
    history, forecast, incomplete = [], None, len(tables) < 2
    if not tables:
        return history, forecast, incomplete
    previous = None
    rows = []
    for table in tables:
        for row in re.findall(r"<tr\b[^>]*>(.*?)</tr>", table, re.S):
            cells = re.findall(r"<t[hd]\b[^>]*>(.*?)</t[hd]>", row, re.S)
            if not cells:
                continue
            period = re.fullmatch(r"(\d{4})年(\d{1,2})月期", plain(cells[0]))
            if period and 1 <= int(period[2]) <= 12:
                previous = tuple(map(int, period.groups()))
                cells = cells[1:]
            if previous and len(cells) >= 6:
                rows.append((previous, cells))
    periods = sorted({y * 12 + m for (y, m), _ in rows})
    for (year, month), cells in rows:
        label = plain(cells[0])
        if label == "予想":
            forecast = number(cells[-1])
            continue
        actual = label == "実績"
        if len(cells) != 6 + actual:
            continue
        quarters = [number(cell) for cell in cells[-5:-1]]
        total = number(cells[-1])
        serial = year * 12 + month
        prior = max((p for p in periods if p < serial), default=serial - 12)
        for index, amount in enumerate(quarters):
            if amount is None:
                continue
            projected_month = month - 3 * (3 - index)
            if index < 3 and serial - prior != 12:
                # Fiscal-year changes can shift interim record dates.
                incomplete = True
                continue
            history.append({"date": period_end(year, projected_month), "amount": amount})
        if total == 0 and all(q is None for q in quarters):
            history.append({"date": period_end(year, month), "amount": 0})
        elif not actual and (total is None or abs(sum(q or 0 for q in quarters) - total) > 0.005):
            incomplete = True
    return history, forecast, incomplete


def market_data(code, detail=False):
    key = (code, detail)
    with LOCK:
        cached = CACHE.get(key)
    if cached and monotonic() - cached[0] < cached[2]:
        return cached[1]

    base = YAHOO + code + ".T"
    result = {"source": base}
    def fetch(suffix):
        try:
            request = Request(base + suffix, headers={"User-Agent": "Mozilla/5.0"})
            with urlopen(request, timeout=8) as response:
                return response.read(4_000_000).decode("utf-8", errors="replace")
        except (OSError, URLError):
            return ""

    if detail:
        pages = list(POOL.map(fetch, ("/incentive", "/profile")))
        incentive, profile = pages
        section = capture(r'<section[^>]*IncentiveDetail[^>]*>(.*?)</section>', incentive)
        website = capture(r'<a\b[^>]*CompanyDescription__button[^>]*href="([^"]+)"', incentive)
        if not website:
            website = capture(r'(?:ホームページ|ウェブサイト|URL)</t[hd]>\s*<td[^>]*>\s*<a[^>]*href="([^"]+)"', profile)
        if not website:
            website = capture(r'下記ウェブサイト参照。<br\s*/?>(https?://[^<\s]+)', section)
        website = unescape(website)
        if re.match(r"^https?://[^/]+", website, re.I):
            result["website"] = website
        summary = capture(r'<meta name="description" content="([^"]*)"', incentive)
        benefit = re.search(r"の株主優待は[、,](.+)", plain(summary))
        if benefit:
            result["benefit"] = benefit[1]
        elif section:
            headings = re.findall(r'<h[23][^>]*>(.*?)</h[23]>', section, re.S)
            result["benefit"] = " / ".join(filter(None, map(plain, headings)))
        elif "株主優待情報はありません" in incentive:
            result["benefit"] = "株主優待情報なし"
        table = capture(r'<table[^>]*IncentiveAndDividend__table[^>]*>(.*?)</table>', incentive)
        if table:
            terms = plain(re.sub(r"</tr>|<br\s*/?>", " / ", re.sub(r"</t[dh]>", " ", table)))
            result["benefitTerms"] = terms.strip(" /")
    else:
        page = fetch("/dividend")
        if not page or "CommonPriceBoard__price_" not in page:
            quote = fetch("")
        else:
            quote = page
        result["name"] = plain(capture(r'<h[12][^>]*BasePriceBoard__name_[^>]*>(.*?)</h[12]>', quote))
        result["price"] = number(capture(r'CommonPriceBoard__price_[^>]*>.*?StyledNumber__value_[^>]*>(.*?)</span>', quote))
        result["asOf"] = plain(capture(r'CommonPriceBoard__times_[^>]*>.*?<time[^>]*>(.*?)</time>', quote))
        result["history"], result["forecast"], result["historyIncomplete"] = dividends(page)
        if result["forecast"] is None:
            result["forecast"] = number(capture(r'1株配当</span><span[^>]*>（会社予想）</span>.*?<dd[^>]*>.*?DataListItem__value_[^>]*>(.*?)</span>', quote))
    success = any(result.get(k) is not None and result.get(k) != "" for k in ("price", "forecast", "website", "benefit"))
    with LOCK:
        CACHE[key] = (monotonic(), result, 300 if success else 20)
    return result


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        path = urlsplit(self.path).path
        match = re.fullmatch(r"/api/(market|detail)/([A-Z0-9]{4})", path)
        if match and CODE.fullmatch(match[2]) and any(c.isdigit() for c in match[2]):
            body = json.dumps(market_data(match[2], match[1] == "detail"), ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        elif path in {"/", "/index.html", "/app.js", "/model.js", "/style.css", "/template.csv", "/example.csv"}:
            super().do_GET()
        else:
            self.send_error(404)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    parser.add_argument("--host", choices=["127.0.0.1"], default="127.0.0.1")
    parser.add_argument("--strictPort", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--open", action="store_true", help="open the app in the default browser")
    args = parser.parse_args()
    port = args.port
    with ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=str(ROOT))) as server:
        address, bound_port = server.server_address
        url = f"http://{address}:{bound_port}/"
        print(url, flush=True)
        if args.open:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
