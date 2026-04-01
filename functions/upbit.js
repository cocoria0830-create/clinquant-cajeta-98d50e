const https = require('https');

exports.handler = async function(event) {
  const qs = event.queryStringParameters || {};
  const path = qs.path || '/v1/ticker';
  
  const extra = Object.entries(qs)
    .filter(([k]) => k !== 'path')
    .map(([k, v]) => k + '=' + v)
    .join('&');
  
  const fullUrl = 'https://api.upbit.com' + path + (extra ? '?' + extra : '');
  
  return new Promise((resolve) => {
    const req = https.get(fullUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
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
      resolve({ statusCode: 500, headers: {'Access-Control-Allow-Origin':'*'}, body: JSON.stringify({error: e.message}) });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve({ statusCode: 408, headers: {'Access-Control-Allow-Origin':'*'}, body: JSON.stringify({error: 'timeout'}) }); });
  });
};
