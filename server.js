const https = require('https');
const crypto = require('crypto');
const http = require('http');
const url = require('url');

function generateToken(accessKey, secretKey) {
  const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const body = Buffer.from(JSON.stringify({access_key:accessKey,nonce:crypto.randomUUID()})).toString('base64url');
  const signature = crypto.createHmac('sha256',secretKey).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','*');
  if(req.method==='OPTIONS'){res.writeHead(200);res.end();return;}
  
  const parsedUrl = url.parse(req.url, true);
  const accessKey = process.env.UPBIT_ACCESS_KEY;
  const secretKey = process.env.UPBIT_SECRET_KEY;
  const token = generateToken(accessKey, secretKey);
  const path = parsedUrl.query.path || '/v1/accounts';

  const options = {
    hostname:'api.upbit.com',
    path: path,
    method:'GET',
    headers:{'Authorization':`Bearer ${token}`,'Accept':'application/json'}
  };

  https.request(options,(upbitRes)=>{
    let data='';
    upbitRes.on('data',chunk=>data+=chunk);
    upbitRes.on('end',()=>{
      res.setHeader('Content-Type','application/json');
      res.writeHead(200);
      res.end(data);
    });
  }).on('error',(e)=>{
    res.writeHead(500);
    res.end(JSON.stringify({error:e.message}));
  }).end();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT,()=>console.log(`Server running on port ${PORT}`));
