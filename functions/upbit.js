const https = require('https');

exports.handler = async function(event) {
  const qs = event.queryStringParameters || {};
  const path = qs.path || '/v1/ticker';
  
  const extra = Object.entries(qs)
    .filter(([k]) => k !== 'path')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');
  
  const fullUrl = 'https://api.upbit.com' + path + (extra ? '?' + extra : '');
  
  console.log('Fetching:', fullUrl);
  
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
            'Access-Control
