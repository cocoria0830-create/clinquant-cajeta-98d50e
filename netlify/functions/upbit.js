const https = require('https');

exports.handler = async (event) => {
  const path = event.queryStringParameters && event.queryStringParameters.path
    ? event.queryStringParameters.path
    : '/v1/ticker?markets=KRW-BTC';

  const url = 'https://api.upbit.com' + path;

  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: 200,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json'
          },
          body: data
        });
      });
    });
    req.on('error', (e) => {
      resolve({ statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: e.message }) });
    });
    req.setTimeout(8000, () => {
      req.destroy();
      resolve({ statusCode: 408, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'timeout' }) });
    });
  });
};
