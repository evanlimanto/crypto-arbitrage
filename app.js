const crypto = require('./crypto');
const Convert = require('ansi-to-html');
const express = require('express');
const app = express();
const convert = new Convert();

app.get('/', (req, res, next) => {
  crypto.generateSpreads(
    (output) =>
    res.send(
      convert.toHtml(
        output.replace(/\n/g, "<br />")
      ).replace(/#FFF/g, "#000")
    ).end());
});

app.listen(
  process.env.PORT || 8080,
  () => console.log('Started server on port', process.env.PORT || 8080)
);
