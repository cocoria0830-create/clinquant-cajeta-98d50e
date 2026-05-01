const https = require('https');
const crypto = require('crypto');
const http = require('http');
const url = require('url');

function generateToken(accessKey, secretKey, query) {
  const payload = { access_key: accessKey, nonce: crypto.randomUUID() };
  if (query) payload.query_hash = crypto.createHash('sha512').update(query).digest('hex');
  if (query) payload.query_hash_alg = 'SHA512';
  const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secretKey).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function upbitRequest(method, path, queryStr, body, accessKey, secretKey) {
  return new Promise((resolve, reject) => {
    const token = generateToken(accessKey, secretKey, queryStr);
    const fullPath = path + (queryStr ? '?' + queryStr : '');
    const options = {
      hostname: 'api.upbit.com',
      path: fullPath,
      method: method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const parsedUrl = url.parse(req.url, true);
  const accessKey = process.env.UPBIT_ACCESS_KEY;
  const secretKey = process.env.UPBIT_SECRET_KEY;

  // IP 확인
  if (parsedUrl.pathname === '/ip') {
    https.get('https://api.ipify.org?format=json', (ipRes) => {
      let data = '';
      ipRes.on('data', chunk => data += chunk);
      ipRes.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.writeHead(200); res.end(data); });
    });
    return;
  }

  // 잔고 조회
  if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/balance') {
    try {
      const data = await upbitRequest('GET', '/v1/accounts', '', null, accessKey, secretKey);
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(data);
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 매수 주문
  if (parsedUrl.pathname === '/order/buy' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { market, price } = JSON.parse(body);
        const orderBody = { market, side: 'bid', price: String(price), ord_type: 'price' };
        const queryStr = Object.keys(orderBody).map(k => `${k}=${encodeURIComponent(orderBody[k])}`).join('&');
        const data = await upbitRequest('POST', '/v1/orders', queryStr, orderBody, accessKey, secretKey);
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(data);
      } catch(e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 매도 주문
  if (parsedUrl.pathname === '/order/sell' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { market, volume } = JSON.parse(body);
        const orderBody = { market, side: 'ask', volume: String(volume), ord_type: 'market' };
        const queryStr = Object.keys(orderBody).map(k => `${k}=${encodeURIComponent(orderBody[k])}`).join('&');
        const data = await upbitRequest('POST', '/v1/orders', queryStr, orderBody, accessKey, secretKey);
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(data);
      } catch(e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
