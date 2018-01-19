const async = require('async');
const colors = require('colors');
const Convert = require('ansi-to-html');
const fs = require('fs');
const Gdax = require('gdax');
const pg = require('pg');
const request = require('request');
const url = require('url');
const Promise = require('bluebird');
const StringBuilder = require('string-builder');
const _ = require('lodash');

const convert = new Convert();

const EXCHANGE = 13380;
const ASYNC_LIMIT = 5;
const REFRESH_INTERVAL = 30 * 1000;

const MARGIN_THRESHOLD = 0.1; // 10 percent
const MAIL_THRESHOLD = 5 * 60 * 1000; // 5 minutes
const FILE_PATH = '/tmp/4rbt1m3';
const MAILGUN_API_KEY = 'key-4d2f3ae1510bce83bcaeeb165bb72140';
const MAILGUN_DOMAIN = 'sandboxc8609fb8f62942dbb335628ee1685dfc.mailgun.org';
const mailgun = require('mailgun-js')({ apiKey: MAILGUN_API_KEY, domain: MAILGUN_DOMAIN });

const getLastEmailTime = () => {
  if (!fs.existsSync(FILE_PATH)) {
    fs.closeSync(fs.openSync(FILE_PATH, 'w'));
    return 0;
  }
  const data = fs.readFileSync(FILE_PATH);
  if (!data || data.length !== 13) {
    return 0;
  }
  const timestamp = parseInt(data, 10);
  if (isNaN(timestamp) || !isFinite(timestamp)) {
    return 0;
  }
  return timestamp;
};

const writeEmailTime = () => {
  const timestamp = Date.now();
  fs.writeFileSync(FILE_PATH, timestamp);
};

const checkEmailTime = () => {
  return (Date.now() - getLastEmailTime() > MAIL_THRESHOLD);
};

const sendEmail = (html) => {
  const data = {
    from: 'Crypto Digest <warren@buffett.mailgun.org>',
    to: 'evanlimanto@gmail.com, philmon.tanuri@gmail.com',
    subject: 'Your Quad-Hourly Rent',
    html: convert.toHtml(
      html.replace(/\n/g, "<br />")
    ).replace(/#FFF/g, "#000"),
  };
  mailgun.messages().send(data, (err, body) => {
    if (err) {
      return console.error(err);
    } else {
      writeEmailTime();
      return console.log(body);
    }
  });
};

const isDevelopment = process.env.NODE_ENV !== "production";

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
        let bid;
        if (code === 'xlm_idr') {
          bid = 7031; // Needs to be updated manually, since API doesn't work
        } else {
          bid = JSON.parse(body).ticker.buy;
        }

        sellPrices[code.slice(0, -4).toUpperCase() + 'USD'] = parseFloat(bid);
        return callback(null, [code, bid]);
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

      let hasHighMargin = false;
      const timestamp = Date.now();
      const emailSb = new StringBuilder();
      emailSb.appendLine(`Good news — time to pay your rent with an interest of ${(MARGIN_THRESHOLD * 100).toFixed(2).toString().green}%!`);

      sb.append((new Date(Date.now())).toString());
      sb.appendLine("USD Arbs");
      usdCodes.forEach((code) => {
        const tempSb = new StringBuilder();
        const margin = sellPrices[code] / (bestPrices[code] * EXCHANGE) - 1;
        tempSb.appendLine(code);
        tempSb.appendLine(`Code: ${code.toString().cyan}, Buy: ${bestPrices[code]}, Exchange: ${bestExchanges[code]}`);
        tempSb.appendLine(`Sell: ${sellPrices[code]}, %: ${(margin * 100).toFixed(2).toString().green}`);

        if (!isNaN(margin) && isFinite(margin) && margin > MARGIN_THRESHOLD) {
          hasHighMargin = true;
          emailSb.appendLine(tempSb.toString());
        }

        if (!isNaN(margin) && isFinite(margin)) {
          pool.query(`insert into margins (code, timestamp, margin)
                      values ('${code}', ${timestamp}, ${margin})`, (err) => err && console.error(err));
        }
        sb.appendLine(tempSb.toString());
      });

      sb.appendLine("===============================");
      sb.appendLine("Crypto Arbs");
      nonUSDCodes.forEach((code) => {
        const tempSb = new StringBuilder();
        const pair = getPair(code);
        if (bestPrices[pair[1] + 'USD']) {
          const margin = sellPrices[pair[0] + 'USD'] / (bestPrices[code] * EXCHANGE * bestPrices[pair[1] + 'USD']) - 1;
          tempSb.appendLine(`Code: ${code.toString().cyan}, Buy: ${bestPrices[code]}, Exchange: ${bestExchanges[code]}`);
          tempSb.appendLine(`%: ${((margin * 100).toFixed(2)).toString().green}`);

          if (!isNaN(margin) && isFinite(margin) && margin > MARGIN_THRESHOLD
              && pair[0] != 'XLM') {
            hasHighMargin = true;
            emailSb.appendLine(tempSb.toString());
          }

          if (!isNaN(margin) && isFinite(margin)) {
            pool.query(`insert into margins (code, timestamp, margin)
                        values ('${code}', ${timestamp}, ${margin})`, (err) => err && console.error(err));
          }
        }
        sb.appendLine(tempSb.toString());
      });

      if (hasHighMargin && checkEmailTime()) {
        sendEmail(emailSb.toString());
      }

      return callback(sb.toString());
    }));
  } catch (e) {
    return callback(e.message);
  }
}

// Postgres
const params = url.parse(process.env.DATABASE_URL);
const auth = params.auth.split(':');

const config = {
  user: auth[0],
  password: auth[1],
  host: params.hostname,
  port: params.port,
  database: params.pathname.split('/')[1],
  ssl: (process.env.NODE_ENV !== 'development'),
};
const pool = new pg.Pool(config);

async function init() {
  await pool.query(`
    create table if not exists margins (
      id serial,
      code varchar(20),
      timestamp bigint,
      margin float
    )
  `);
}

init();

const display = () => generateSpreads((output) => {
  if (!isDevelopment) {
    console.log(output);
    console.log("\n\n========================================\n\n");
  }
  setTimeout(display, REFRESH_INTERVAL);
});

display();

module.exports = { generateSpreads };
