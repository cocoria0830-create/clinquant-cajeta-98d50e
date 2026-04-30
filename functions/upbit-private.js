const https = require('https');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

exports.handler = async function(event) {
  const accessKey = process.env.UPBIT_ACCESS_KEY;
  const secretKey = process.env.UPBIT_SECRET_KEY;
  const action = event.queryStringParameters?.action || 'balance';

  const payload = { access_key: accessKey, nonce: uuidv4() };
  const token = require('jsonwebtoken').sign(payload, secretKey);

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.upbit.com',
      path: '/v1/accounts',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: 200,
          headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
          body: data
        });
      });
    });

    req.on('error', (e) => {
      resolve({ statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: e.message }) });
    });
    req.end();
  });
};
