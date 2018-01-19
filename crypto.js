const async = require('async');
const colors = require('colors');
const Gdax = require('gdax');
const request = require('request');
const sqlite = require('sqlite');
const Promise = require('bluebird');
const StringBuilder = require('string-builder');
const _ = require('lodash');

const EXCHANGE = 13380;
const ASYNC_LIMIT = 5;
const REFRESH_INTERVAL = 30 * 1000;

const isDevelopment = process.env.NODE_ENV !== "production";

const dbPromise = sqlite.open('./database.sqlite', { Promise });
let db = null;

// bitcoin.id
const idrCodes = [
  'btc_idr',
  'bch_idr',
  'btg_idr',
  'eth_idr',
  'etc_idr',
  'ignis_idr',
  'ltc_idr',
  'nxt_idr',
  'waves_idr',
  'xlm_idr',
  'xrp_idr',
  'xzc_idr',
];
const currencyCodes = new Set(idrCodes.map(code => code.slice(0, -4).toUpperCase()).concat('USD'));
const usdCodes = new Set(idrCodes.map(code => code.slice(0, -4).toUpperCase() + 'USD'));
const currencyCodesDashed = new Set(idrCodes.map(code => code.slice(0, -4).toUpperCase() + '-USD'));

const sellPrices = {};
let bestExchanges = {};
const bestPrices = {};
const bestMargins = {};

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
  const margin = sellPrices[codePair[0] + 'USD'] /
    (price * EXCHANGE * bestPrices[codePair[1] + 'USD']) - 1;
  if (!bestExchanges[market] || Math.abs(margin) > Math.abs(bestMargins[market])) {
    bestExchanges[market] = exchange;
    bestPrices[market] = price;
    bestMargins[market] = margin;
  }
}

exchangeAPIs = {
  "bitcoin.co.id":
  (outerCallback) =>
    // bitcoin.co.id
    async.eachLimit(idrCodes, ASYNC_LIMIT, (code, callback) => {
      request('https://vip.bitcoin.co.id/api/' + code + '/ticker', (err, res, body) => {
        if (err) {
          return callback(err);
        }
        if (code === 'xlm_idr') {
          sell = 7271; // Needs to be updated manually, since API doesn't work
        } else {
          sell = JSON.parse(body).ticker.sell;
        }

        sellPrices[code.slice(0, -4).toUpperCase() + 'USD'] = parseFloat(sell);
        return callback(null, [code, sell]);
      });
    }, outerCallback),

  "binance":
  (callback) =>
    // Binance
    request('https://api.binance.com/api/v3/ticker/price', (err, res, body) => {
      if (err) {
        return callback(err);
      }
      JSON.parse(body).forEach((item) => {
        update(item.symbol, item.price, 'binance');
      });
      return callback(null);
    }),

  "gdax":
  (outerCallback) => {
    // GDAX
    const gdaxClient = new Gdax.PublicClient();
    gdaxClient.getProducts((err, res, body) => {
      async.eachLimit(body, ASYNC_LIMIT, (item, callback) => {
        const { id } = item;
        const publicClient = new Gdax.PublicClient(id);
        publicClient.getProductTicker((err, res, data) => {
          if (err) {
            return callback(err);
          }
          update(id.split('-').join(''), data.price, 'gdax');
          return callback(null);
        });
      }, outerCallback);
    });
  },

  "gemini":
  (outerCallback) => {
    // Gemini
    request('https://api.gemini.com/v1/symbols', (err, res, body) => {
      if (err) {
        return outerCallback(err);
      }
      const symbols = JSON.parse(body).map(item => item.toUpperCase()).filter(symbol => usdCodes.has(symbol));
      async.map(symbols, (item, callback) => {
        request('https://api.gemini.com/v1/pubticker/' + item, (err, res, body) => {
          if (err) {
            return callback(err);
          }
          const ticker = JSON.parse(body)
          update(item, parseFloat(ticker['ask']), 'gemini')
          return callback(null);
        });
      }, outerCallback);
    })
  },

  "kraken":
  (outerCallback) => {
    // Kraken
    request('https://api.kraken.com/0/public/AssetPairs', (err, res, body) => {
      if (err) {
        return outerCallback(err);
      }
      const result = JSON.parse(body).result;
      async.forEach(Object.keys(result), (item, callback) => {
        request('https://api.kraken.com/0/public/Ticker?pair=' + item, (err, res, body) => {
          if (err) {
            return callback(err);
          }
          const bodyObj = JSON.parse(body);
          if (bodyObj.error.length > 0) {
            return callback(null);
          }
          const ask = bodyObj.result[item].a[0]; // Ask price
          update(item, parseFloat(ask), 'kraken');
          return callback(null);
        });
      }, outerCallback);
    })
  },

  "bitfinex":
  (callback) =>
    // BitFinex
    request('https://api.bitfinex.com/v1/symbols', (err, res, body) => {
      if (err) {
        return callback(err);
      }
      const param = JSON.parse(body).map(item => `t${item.toUpperCase()}`).join(',');
      request('https://api.bitfinex.com/v2/tickers?symbols=' + param, (err, res, body) => {
        if (err) {
          return callback(err);
        }
        JSON.parse(body).forEach(item => {
          update(item[0].slice(1), item[1], 'bitfinex');
        });
        return callback(null);
      });
    }),

  "coinbase":
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
        return innerCallback(null);
      });
    }, callback),

  "bittrex":
  (outerCallback) =>
    // Bittrex
    request('https://bittrex.com/api/v1.1/public/getmarkets', (err, res, body) => {
      if (err) {
        return outerCallback(err);
      }
      const data = JSON.parse(body).result;
      const markets = data.map(item => item.MarketName);
      async.eachLimit(markets, ASYNC_LIMIT, (market, callback) => {
        const code = market.split('-').join('');
        const pair = getPair(code);
        if (pair) {
          request('https://bittrex.com/api/v1.1/public/getticker?market=' + market, (err, res, body) => {
            if (err) {
              return callback(err);
            }
            const ask = JSON.parse(body).result.Ask;
            update(pair[1] + pair[0], ask, 'bittrex');
            return callback(null);
          });
        } else {
          return callback(null);
        }
      }, outerCallback);
    }),
}

const exchanges = ["binance", "gdax", "bittrex", "kraken"];

const generateSpreads = (callback) => {
  try {
    bestExchanges = {};
    async.parallel([
      exchangeAPIs["bitcoin.co.id"]
    ], (err) => async.parallel(exchanges.map(exchange => exchangeAPIs[exchange]), (err) => {
      if (err) {
        return callback(err);
      }
      const usdCodes = Object.keys(bestPrices).filter(code => code.endsWith('USD')).sort();
      const nonUSDCodes = Object.keys(bestPrices).filter(code => !usdCodes.includes(code)).sort();

      const sb = new StringBuilder();
      const timestamp = Date.now();

      sb.append((new Date(Date.now())).toString());
      sb.appendLine("USD Arbs");
      usdCodes.forEach((code) => {
        sb.appendLine(code);
        sb.appendLine(`Code: ${code.toString().cyan}, Buy: ${bestPrices[code]}, Exchange: ${bestExchanges[code]}`);
        const margin = sellPrices[code] / (bestPrices[code] * EXCHANGE) - 1;
        sb.appendLine(`Sell: ${sellPrices[code]}, %: ${((margin * 100).toFixed(2)).toString().green}`);
        sb.appendLine();

        if (isDevelopment && !isNaN(margin) && isFinite(margin)) {
          db.run(`insert into margins (code, timestamp, margin)
                  values ('${code}', ${timestamp}, ${margin})`);
        }
      });

      sb.appendLine("===============================");
      sb.appendLine("Crypto Arbs");
      nonUSDCodes.forEach((code) => {
        sb.appendLine(`Code: ${code.toString().cyan}, Buy: ${bestPrices[code]}, Exchange: ${bestExchanges[code]}`);
        const pair = getPair(code);
        if (bestPrices[pair[1] + 'USD']) {
          const margin = sellPrices[pair[0] + 'USD'] / (bestPrices[code] * EXCHANGE * bestPrices[pair[1] + 'USD']) - 1;
          sb.appendLine(`%: ${((margin * 100).toFixed(2)).toString().green}`);

          if (isDevelopment && !isNaN(margin) && isFinite(margin)) {
            db.run(`insert into margins (code, timestamp, margin)
                    values ('${code}', ${timestamp}, ${margin})`);
          }
        }
        sb.appendLine();
      });

      return callback(sb.toString());
    }));
  } catch (e) {
    return callback(e.message);
  }
}

async function init() {
  db = await dbPromise;
  db.run(`
    create table if not exists margins (
      id integer primary key,
      code varchar(20),
      timestamp integer,
      margin float
    )
  `);
}

if (isDevelopment) {
  init();
}

if (require.main === module) {
  const display = () => generateSpreads((output) => {
    console.log(output);
    console.log("\n\n========================================\n\n");
    setTimeout(display, REFRESH_INTERVAL);
  });

  display();
}

module.exports = { generateSpreads };
