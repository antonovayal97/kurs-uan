# Курс юань / рубль (Node.js + PM2)

Считает **CNY/RUB** через:

1. **Sell USDT→CNY** — [HTX P2P](https://www.htx.com/en-us/fiat-crypto/c2c-common/sell-usdt-cny/)  
   фильтры: **3000 ¥**, **Alipay**, без ID и без телефона  
2. **Покупка USDT** — A7A5 Ethereum DEX  

Наценка 1–10% настраивается на странице.

## Требования

- Node.js **≥ 18**
- PM2 (на VPS)

## Локально

```bash
node server.js
```

http://127.0.0.1:8765

## PM2 (VPS)

```bash
npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Полезные команды:

```bash
pm2 status
pm2 logs kurs-valut
pm2 restart kurs-valut
pm2 stop kurs-valut
```

Порт и хост — через env в `ecosystem.config.cjs` (`HOST`, `PORT`). По умолчанию `0.0.0.0:8765`.

## Firewall

```bash
sudo ufw allow 8765/tcp
```
