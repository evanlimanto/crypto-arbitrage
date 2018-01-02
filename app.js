const async = require('async');
const Gdax = require('gdax');
const request = require('request');
const _ = require('lodash');

const EXCHANGE = 13556;
const ASYNC_LIMIT = 5;

// bitcoin.id
const idrCodes = [
  'btc_idr',
  'bch_idr',
  'btg_idr',
  'eth_idr',
  'etc_idr',
  'ltc_idr',
  'xrp_idr',
];
const currencyCodes = new Set(idrCodes.map(code => code.slice(0, -4).toUpperCase()).concat('USD'));
const usdCodes = new Set(idrCodes.map(code => code.slice(0, -4).toUpperCase() + 'USD'));
const currencyCodesDashed = new Set(idrCodes.map(code => code.slice(0, -4).toUpperCase() + '-USD'));

const sellPrices = {};
const bestExchanges = {};
const bestPrices = {};

function getPair(market) {
  for (const codeA of currencyCodes) {
    if (market.startsWith(codeA)) {
      const codeB = market.slice(codeA.length);
      if (currencyCodes.has(codeB)) {
        return [codeA, codeB];
      }
    }
  }
  return null;
}

function update(market, price, exchange) {
  const codePair = getPair(market);
  if (!codePair) {
    return;
  }
  price = parseFloat(price);
  if (!bestExchanges[market] || (price < bestPrices[market])) {
    bestExchanges[market] = exchange;
    bestPrices[market] = price;
  }
}

async.parallel([
  (outerCallback) =>
    // bitcoin.co.id
    async.eachLimit(idrCodes, ASYNC_LIMIT, (code, callback) => {
      request('https://vip.bitcoin.co.id/api/' + code + '/ticker', (err, res, body) => {
        if (err) {
          return callback(err);
        }

        const sell = JSON.parse(body).ticker.sell;
        sellPrices[code.slice(0, -4).toUpperCase() + 'USD'] = sell;
        return callback(null, [code, sell]);
      });
    }, outerCallback),

  (callback) =>
    // Binance
    request('https://api.binance.com/api/v3/ticker/price', (err, res, body) => {
      JSON.parse(body).forEach((item) => {
        update(item.symbol, item.price, 'binance');
      });
      return callback(err);
    }),

  (outerCallback) => {
    // GDAX
    const gdaxClient = new Gdax.PublicClient();
    gdaxClient.getProducts((err, res, body) => {
      async.eachLimit(body, ASYNC_LIMIT, (item, callback) => {
        const { id } = item;
        const publicClient = new Gdax.PublicClient(id);
        publicClient.getProductTicker((err, res, data) => {
          if (err) return callback(err);
          update(id.split('-').join(''), data.price, 'gdax');
          return callback(null);
        });
      }, outerCallback);
    });
  },

  (callback) =>
    // BitFinex
    request('https://api.bitfinex.com/v1/symbols', (err, res, body) => {
      const param = JSON.parse(body).map(item => `t${item.toUpperCase()}`).join(',');
      request('https://api.bitfinex.com/v2/tickers?symbols=' + param, (err, res, body) => {
        JSON.parse(body).forEach(item => {
          update(item[0].slice(1), item[1], 'bitfinex');
        });
        return callback(err);
      });
    }),

  (callback) =>
    // Coinbase
    async.map(currencyCodesDashed, (code, innerCallback) => {
      request('https://api.coinbase.com/v2/prices/' + code + '/buy', (err, res, body) => {
        if (err) {
          return innerCallback(null);
        }
        const parsed = JSON.parse(body);
        if (parsed.errors) {
          return innerCallback(null);
        }
        const { base, amount } = parsed.data;
        update(base + 'USD', amount, 'coinbase');
        return innerCallback(err);
      });
    }, (err) => callback(err)),

  (outerCallback) =>
    // Bittrex
    request('https://bittrex.com/api/v1.1/public/getmarkets', (err, res, body) => {
      const data = JSON.parse(body).result;
      const markets = data.map(item => item.MarketName);
      async.eachLimit(markets, ASYNC_LIMIT, (market, callback) => {
        if (getPair(market)) {
          request('https://bittrex.com/api/v1.1/public/getticker?market=' + market, (err, res, body) => {
            const bid = JSON.parse(body).result.Bid;
            update(market.split('-').join(''), bid, 'bittrex');
            return callback(null);
          });
        } else {
          return callback(null);
        }
      }, outerCallback);
    }),
], (err) => {
  if (err) return console.error(err);
  console.log("Currency Pairs");
  for (const code in bestPrices) {
    console.log(`Code: ${code}, Buy: ${bestPrices[code]}, Exchange; ${bestExchanges[code]}`);
    if (code.endsWith('USD')) {
      const profit = sellPrices[code] / (bestPrices[code] * EXCHANGE) - 1;
      console.log(`Sell: ${sellPrices[code]}, %: ${profit}`);
    }
    console.log();
  }

  console.log("===================================");

  for (const code in sellPrices) {
    console.log(`Code: ${code}, Sell: ${sellPrices[code]}`);
  }
  return;
});
