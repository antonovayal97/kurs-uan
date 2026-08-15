#!/usr/bin/env python3
"""Курс юань/рубль: HTX P2P Sell USDT/CNY (Alipay) + A7A5 Ethereum DEX."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from Crypto.Hash import keccak

ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = 8765

ETH_EXCHANGE = "0x8D7512e58f41274d4d9b123C0f8a2A5572b8EAbE"
ETH_RPCS = [
    "https://ethereum.publicnode.com",
    "https://1rpc.io/eth",
    "https://eth.drpc.org",
    "https://rpc.payload.de",
    "https://eth-mainnet.public.blastapi.io",
]

# HTX: Sell USDT → CNY, Alipay=2, CNY currency=1, amount 3000
HTX_PAGE = "https://www.htx.com/en-us/fiat-crypto/c2c-common/sell-usdt-cny/"
HTX_API = "https://otc-api.htx.com/v1/data/trade-market"
HTX_ALIPAY = 2
CNY_AMOUNT = 3000

# takerLimit bits (из фронта HTX):
# 1 = привязка телефона, 2 = senior KYC, 4 = real-name / ID
TAKER_PHONE = 1
TAKER_SENIOR = 2
TAKER_ID = 4


def selector(signature: str) -> str:
    h = keccak.new(digest_bits=256)
    h.update(signature.encode())
    return "0x" + h.hexdigest()[:8]


SEL_A7A5_TO_USDT = selector("quoteA7A5ToUSDT(uint256)")
SEL_USDT_TO_A7A5 = selector("quoteUSDTToA7A5(uint256)")


def http_json(url: str, method: str = "GET", body: dict | None = None, headers: dict | None = None) -> dict:
    hdrs = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    if headers:
        hdrs.update(headers)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode())


def eth_call(rpc: str, to: str, data: str) -> str:
    payload = http_json(
        rpc,
        method="POST",
        body={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_call",
            "params": [{"to": to, "data": data}, "latest"],
        },
        headers={"Content-Type": "application/json"},
    )
    if payload.get("error"):
        raise RuntimeError(payload["error"])
    result = payload.get("result")
    if not result or result == "0x":
        raise RuntimeError("empty eth_call result")
    return result


def fetch_eth_usdt_rates() -> dict:
    amount_data = format(10**6, "064x")
    last_err: Exception | None = None
    for rpc in ETH_RPCS:
        try:
            raw_a2u = int(eth_call(rpc, ETH_EXCHANGE, SEL_A7A5_TO_USDT + amount_data), 16)
            raw_u2a = int(eth_call(rpc, ETH_EXCHANGE, SEL_USDT_TO_A7A5 + amount_data), 16)
            usdt_for_1_a7a5 = raw_a2u / 1e6
            if usdt_for_1_a7a5 <= 0:
                raise RuntimeError("zero quote")
            sell_ratio = round(1 / usdt_for_1_a7a5, 2)
            buy_ratio = round(raw_u2a / 1e6, 2)
            return {
                "usdt_buy_rate": sell_ratio,
                "usdt_sell_rate": buy_ratio,
                "rpc": rpc,
                "contract": ETH_EXCHANGE,
            }
        except Exception as e:
            last_err = e
    raise RuntimeError(f"ETH quote failed: {last_err}")


def htx_no_id_no_phone(ad: dict) -> bool:
    limit = int(ad.get("takerLimit") or 0)
    if limit & TAKER_PHONE:
        return False
    if limit & TAKER_ID:
        return False
    if limit & TAKER_SENIOR:
        return False
    return True


def fetch_htx_cny_offers() -> dict:
    """Sell USDT / CNY, Alipay, 3000 ¥ — как на HTX c2c sell-usdt-cny."""
    qs = urllib.parse.urlencode(
        {
            "coinId": 2,
            "currency": 1,
            "tradeType": "sell",
            "currPage": 1,
            "payMethod": HTX_ALIPAY,
            "acceptOrder": -1,
            "country": "",
            "blockType": "general",
            "online": 1,
            "range": 0,
            "amount": CNY_AMOUNT,
        }
    )
    raw = http_json(
        f"{HTX_API}?{qs}",
        headers={"client-type": "web", "Referer": HTX_PAGE, "Origin": "https://www.htx.com"},
    )
    ads = raw.get("data") or []
    filtered = [a for a in ads if htx_no_id_no_phone(a)]
    # если биты не заполнены API — берём все Alipay-офферы на сумму
    use = filtered if filtered else ads
    use = sorted(use, key=lambda a: float(a.get("price") or 0), reverse=True)
    best = use[0] if use else None
    return {
        "source": "htx",
        "page": HTX_PAGE,
        "total": len(ads),
        "matched": len(use),
        "filtered_no_id_phone": len(filtered),
        "best": None
        if not best
        else {
            "price": float(best["price"]),
            "user": best.get("userName"),
            "min": best.get("minTradeLimit"),
            "max": best.get("maxTradeLimit"),
            "takerLimit": best.get("takerLimit"),
            "payMethods": [p.get("name") for p in (best.get("payMethods") or [])],
        },
        "note": None
        if ads
        else "HTX вернул 0 объявлений CNY (часто геоблок вне Китая). Используем запасной P2P.",
    }


def fetch_binance_cny_fallback() -> dict:
    """Запасной источник с теми же условиями: Sell USDT, CNY, Alipay, 3000, без доп. KYC."""
    raw = http_json(
        "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search",
        method="POST",
        body={
            "fiat": "CNY",
            "page": 1,
            "rows": 20,
            "tradeType": "SELL",
            "asset": "USDT",
            "payTypes": ["alipay"],
            "transAmount": str(CNY_AMOUNT),
            "publisherType": None,
            "proMerchantAds": False,
            "shieldMerchantAds": False,
        },
        headers={"clienttype": "web"},
    )
    ads = raw.get("data") or []
    ok = []
    for row in ads:
        adv = row.get("adv") or {}
        if int(adv.get("takerAdditionalKycRequired") or 0) != 0:
            continue
        if adv.get("buyerKycLimit") not in (None, 0, "0"):
            continue
        ok.append(row)
    use = ok or ads
    # при продаже USDT выгоднее более высокая цена в CNY
    use = sorted(use, key=lambda r: float((r.get("adv") or {}).get("price") or 0), reverse=True)
    best = use[0] if use else None
    adv = (best or {}).get("adv") or {}
    advr = (best or {}).get("advertiser") or {}
    return {
        "source": "binance_p2p_fallback",
        "page": "https://p2p.binance.com/en/trade/sell/USDT?fiat=CNY&payment=alipay",
        "total": len(ads),
        "matched": len(use),
        "best": None
        if not best
        else {
            "price": float(adv["price"]),
            "user": advr.get("nickName"),
            "min": adv.get("minSingleTransAmount"),
            "max": adv.get("maxSingleTransAmount"),
            "payMethods": [m.get("tradeMethodName") for m in (adv.get("tradeMethods") or [])],
            "takerAdditionalKycRequired": adv.get("takerAdditionalKycRequired"),
        },
    }


def fetch_cny_usdt_rate() -> dict:
    htx = fetch_htx_cny_offers()
    if htx.get("best"):
        return htx
    fb = fetch_binance_cny_fallback()
    fb["htx_empty"] = True
    fb["htx_note"] = htx.get("note")
    if not fb.get("best"):
        raise RuntimeError("Нет офферов CNY/Alipay ни на HTX, ни на запасном P2P")
    return fb


def build_payload() -> dict:
    eth = fetch_eth_usdt_rates()
    cny = fetch_cny_usdt_rate()
    usdt_rub = float(eth["usdt_buy_rate"])  # A7A5 ≈ ₽ за 1 USDT (покупка)
    usdt_cny = float(cny["best"]["price"])  # ¥ за 1 USDT (продажа USDT)
    # 1 CNY ≈ сколько ₽
    cny_rub_raw = round(usdt_rub / usdt_cny, 4)
    markup = 1.05  # +5%
    cny_rub = round(cny_rub_raw * markup, 4)
    rub_example = 100_000
    cny_for_rub = round(rub_example / cny_rub, 2) if cny_rub else 0
    return {
        "ok": True,
        "cny_rub": cny_rub,
        "cny_rub_raw": cny_rub_raw,
        "markup_percent": 5,
        "rub_example": rub_example,
        "cny_for_rub_example": cny_for_rub,
        "filters": {
            "amount_cny": CNY_AMOUNT,
            "pay": "Alipay",
            "side": "sell USDT / get CNY",
            "no_id_verify": True,
            "no_phone_bind": True,
        },
        "usdt_rub_buy": usdt_rub,
        "usdt_cny_sell": usdt_cny,
        "eth": eth,
        "cny_market": cny,
        "formula": "cny_rub = (usdt_rub_buy / usdt_cny_sell) * (1 + markup%); cny = rub / cny_rub",
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {args[0]}")

    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]

        if path in ("/", "/index.html"):
            self._send(200, (ROOT / "index.html").read_bytes(), "text/html; charset=utf-8")
            return

        if path in ("/api/prices", "/api/cny-rub"):
            try:
                payload = build_payload()
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self._send(200, body, "application/json; charset=utf-8")
            except Exception as e:
                err = json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False).encode()
                self._send(502, err, "application/json; charset=utf-8")
            return

        self._send(404, b"Not found", "text/plain; charset=utf-8")


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Откройте http://{HOST}:{PORT}")
    print("CNY: HTX sell-usdt-cny Alipay 3000 → CNY/RUB через A7A5 ETH")
    server.serve_forever()


if __name__ == "__main__":
    main()
