# Курс юань / рубль

Считает **CNY/RUB** через:

1. **Sell USDT→CNY** — [HTX P2P](https://www.htx.com/en-us/fiat-crypto/c2c-common/sell-usdt-cny/)  
   фильтры: **3000 ¥**, **Alipay**, без ID-верификации и без привязки телефона  
2. **Покупка USDT** — A7A5 Ethereum DEX (`trade_and_earn?chain=eth`)

Формула: `1 CNY ≈ (₽ за 1 USDT) / (¥ за 1 USDT)`

Если HTX CNY с текущего IP пустой (геоблок), берётся запасной P2P с теми же фильтрами.

## Запуск

```bash
.venv/bin/pip install pycryptodome   # один раз
.venv/bin/python server.py
```

http://127.0.0.1:8765
