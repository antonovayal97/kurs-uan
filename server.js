#!/usr/bin/env node
/**
 * Курс юань/бат → рубль: HTX P2P CNY + Binance TH USDT/THB + A7A5 Ethereum DEX
 * Запуск: node server.js | pm2 start ecosystem.config.cjs
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8765);

const ETH_EXCHANGE = "0x8D7512e58f41274d4d9b123C0f8a2A5572b8EAbE";
const ETH_RPCS = [
  "https://ethereum.publicnode.com",
  "https://1rpc.io/eth",
  "https://eth.drpc.org",
  "https://rpc.payload.de",
  "https://eth-mainnet.public.blastapi.io",
];

// keccak256 selectors
const SEL_A7A5_TO_USDT = "0xb8ca076b";
const SEL_USDT_TO_A7A5 = "0xe0fe220a";

const HTX_PAGE = "https://www.htx.com/en-us/fiat-crypto/c2c-common/sell-usdt-cny/";
const HTX_API = "https://otc-api.htx.com/v1/data/trade-market";
const HTX_ALIPAY = 2;
const CNY_AMOUNT = 3000;

const TAKER_PHONE = 1;
const TAKER_SENIOR = 2;
const TAKER_ID = 4;

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36";

async function httpJson(url, { method = "GET", body, headers = {} } = {}) {
  const hdrs = {
    "User-Agent": UA,
    Accept: "application/json",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    ...headers,
  };
  const init = { method, headers: hdrs, signal: AbortSignal.timeout(20000) };
  if (body !== undefined) {
    hdrs["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}`);
  }
  return res.json();
}

async function ethCall(rpc, to, data) {
  const payload = await httpJson(rpc, {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    },
  });
  if (payload.error) throw new Error(JSON.stringify(payload.error));
  const result = payload.result;
  if (!result || result === "0x") throw new Error("empty eth_call result");
  return result;
}

async function fetchEthUsdtRates() {
  const amountData = (10n ** 6n).toString(16).padStart(64, "0");
  let lastErr;
  for (const rpc of ETH_RPCS) {
    try {
      const rawA2u = BigInt(
        await ethCall(rpc, ETH_EXCHANGE, SEL_A7A5_TO_USDT + amountData)
      );
      const rawU2a = BigInt(
        await ethCall(rpc, ETH_EXCHANGE, SEL_USDT_TO_A7A5 + amountData)
      );
      const usdtFor1A7a5 = Number(rawA2u) / 1e6;
      if (usdtFor1A7a5 <= 0) throw new Error("zero quote");
      return {
        usdt_buy_rate: Math.round((1 / usdtFor1A7a5) * 100) / 100,
        usdt_sell_rate: Math.round((Number(rawU2a) / 1e6) * 100) / 100,
        rpc,
        contract: ETH_EXCHANGE,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`ETH quote failed: ${lastErr}`);
}

function htxNoIdNoPhone(ad) {
  const limit = Number(ad.takerLimit || 0);
  if (limit & TAKER_PHONE) return false;
  if (limit & TAKER_ID) return false;
  if (limit & TAKER_SENIOR) return false;
  return true;
}

async function fetchHtxCnyOffers() {
  const qs = new URLSearchParams({
    coinId: "2",
    currency: "1",
    tradeType: "sell",
    currPage: "1",
    payMethod: String(HTX_ALIPAY),
    acceptOrder: "-1",
    country: "",
    blockType: "general",
    online: "1",
    range: "0",
    amount: String(CNY_AMOUNT),
  });
  const raw = await httpJson(`${HTX_API}?${qs}`, {
    headers: {
      "client-type": "web",
      Referer: HTX_PAGE,
      Origin: "https://www.htx.com",
    },
  });
  const ads = raw.data || [];
  const filtered = ads.filter(htxNoIdNoPhone);
  let use = filtered.length ? filtered : ads;
  use = [...use].sort((a, b) => Number(b.price || 0) - Number(a.price || 0));
  const best = use[0] || null;
  return {
    source: "htx",
    page: HTX_PAGE,
    total: ads.length,
    matched: use.length,
    filtered_no_id_phone: filtered.length,
    best: best
      ? {
          price: Number(best.price),
          user: best.userName,
          min: best.minTradeLimit,
          max: best.maxTradeLimit,
          takerLimit: best.takerLimit,
          payMethods: (best.payMethods || []).map((p) => p.name),
        }
      : null,
    note: ads.length
      ? null
      : "HTX вернул 0 объявлений CNY (часто геоблок вне Китая). Используем запасной P2P.",
  };
}

async function fetchBinanceCnyFallback() {
  const raw = await httpJson(
    "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search",
    {
      method: "POST",
      body: {
        fiat: "CNY",
        page: 1,
        rows: 20,
        tradeType: "SELL",
        asset: "USDT",
        payTypes: ["alipay"],
        transAmount: String(CNY_AMOUNT),
        publisherType: null,
        proMerchantAds: false,
        shieldMerchantAds: false,
      },
      headers: { clienttype: "web" },
    }
  );
  const ads = raw.data || [];
  const ok = ads.filter((row) => {
    const adv = row.adv || {};
    if (Number(adv.takerAdditionalKycRequired || 0) !== 0) return false;
    if (![null, undefined, 0, "0"].includes(adv.buyerKycLimit)) return false;
    return true;
  });
  let use = ok.length ? ok : ads;
  use = [...use].sort(
    (a, b) => Number(b.adv?.price || 0) - Number(a.adv?.price || 0)
  );
  const best = use[0] || null;
  const adv = best?.adv || {};
  const advr = best?.advertiser || {};
  return {
    source: "binance_p2p_fallback",
    page: "https://p2p.binance.com/en/trade/sell/USDT?fiat=CNY&payment=alipay",
    total: ads.length,
    matched: use.length,
    best: best
      ? {
          price: Number(adv.price),
          user: advr.nickName,
          min: adv.minSingleTransAmount,
          max: adv.maxSingleTransAmount,
          payMethods: (adv.tradeMethods || []).map((m) => m.tradeMethodName),
          takerAdditionalKycRequired: adv.takerAdditionalKycRequired,
        }
      : null,
  };
}

async function fetchCnyUsdtRate() {
  const htx = await fetchHtxCnyOffers();
  if (htx.best) return htx;
  const fb = await fetchBinanceCnyFallback();
  fb.htx_empty = true;
  fb.htx_note = htx.note;
  if (!fb.best) {
    throw new Error("Нет офферов CNY/Alipay ни на HTX, ни на запасном P2P");
  }
  return fb;
}

const BINANCE_TH_PAGE = "https://www.binance.th/en/trade/USDT_THB";
const BINANCE_TH_TICKER =
  "https://api.binance.th/api/v1/ticker/price?symbol=USDTTHB";

async function fetchBinanceThUsdtThb() {
  const raw = await httpJson(BINANCE_TH_TICKER, {
    headers: {
      Referer: BINANCE_TH_PAGE,
      Origin: "https://www.binance.th",
    },
  });
  const price = Number(raw.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Binance TH: пустая цена USDTTHB");
  }
  return {
    source: "binance_th",
    page: BINANCE_TH_PAGE,
    symbol: raw.symbol || "USDTTHB",
    best: { price },
  };
}

async function buildPayload() {
  const [eth, cny, thb] = await Promise.all([
    fetchEthUsdtRates(),
    fetchCnyUsdtRate(),
    fetchBinanceThUsdtThb(),
  ]);
  const usdtRub = Number(eth.usdt_buy_rate);
  const usdtCny = Number(cny.best.price);
  const usdtThb = Number(thb.best.price);
  const cnyRubRaw = Math.round((usdtRub / usdtCny) * 10000) / 10000;
  const thbRubRaw = Math.round((usdtRub / usdtThb) * 10000) / 10000;
  const markup = 1.05;
  const cnyRub = Math.round(cnyRubRaw * markup * 10000) / 10000;
  const thbRub = Math.round(thbRubRaw * markup * 10000) / 10000;
  const rubExample = 100000;
  const cnyForRub = cnyRub ? Math.round((rubExample / cnyRub) * 100) / 100 : 0;
  const thbForRub = thbRub ? Math.round((rubExample / thbRub) * 100) / 100 : 0;
  return {
    ok: true,
    cny_rub: cnyRub,
    cny_rub_raw: cnyRubRaw,
    thb_rub: thbRub,
    thb_rub_raw: thbRubRaw,
    markup_percent: 5,
    rub_example: rubExample,
    cny_for_rub_example: cnyForRub,
    thb_for_rub_example: thbForRub,
    filters: {
      amount_cny: CNY_AMOUNT,
      pay: "Alipay",
      side: "sell USDT / get CNY",
      no_id_verify: true,
      no_phone_bind: true,
    },
    usdt_rub_buy: usdtRub,
    usdt_cny_sell: usdtCny,
    usdt_thb: usdtThb,
    eth,
    cny_market: cny,
    thb_market: thb,
    formula:
      "fiat_rub = (usdt_rub_buy / usdt_fiat) * (1 + markup%); fiat = rub / fiat_rub",
  };
}

function send(res, code, body, contentType) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(code, {
    "Content-Type": contentType,
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
  });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    try {
      const html = fs.readFileSync(path.join(__dirname, "index.html"));
      send(res, 200, html, "text/html; charset=utf-8");
    } catch {
      send(res, 500, "index.html not found", "text/plain; charset=utf-8");
    }
    return;
  }

  if (
    req.method === "GET" &&
    (pathname === "/api/prices" || pathname === "/api/cny-rub")
  ) {
    try {
      const payload = await buildPayload();
      send(
        res,
        200,
        JSON.stringify(payload),
        "application/json; charset=utf-8"
      );
    } catch (e) {
      send(
        res,
        502,
        JSON.stringify({ ok: false, error: String(e.message || e) }),
        "application/json; charset=utf-8"
      );
    }
    return;
  }

  send(res, 404, "Not found", "text/plain; charset=utf-8");
});

server.listen(PORT, HOST, () => {
  console.log(`Откройте http://${HOST}:${PORT}`);
  console.log(
    "CNY: HTX Alipay 3000 · THB: Binance TH USDT/THB → RUB через A7A5 ETH"
  );
});
