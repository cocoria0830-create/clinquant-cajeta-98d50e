const https = require('https');

exports.handler = async function(event) {
  const qs = event.queryStringParameters || {};
  const path = qs.path || '/v1/ticker';
  
  // path 이후의 나머지 쿼리스트링 파라미터들 수집 (markets 등)
  const extra = Object.entries(qs)
    .filter(([k]) => k !== 'path')
    .map(([k,v]) => k+'='+v)
    .join('&');
  
  const fullUrl = 'https://api.upbit.com' + path + (extra ? '?' + extra : '');
  
  return new Promise((resolve) => {
    https.get(fullUrl, {
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
    }).on('error', (e) => {
      resolve({ statusCode: 500, headers: {'Access-Control-Allow-Origin':'*'}, body: JSON.stringify({error: e.message}) });
    });
  });
};
