// Usage: GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/get-refresh-token.mjs
import http from 'node:http';
import { google } from 'googleapis';

const redirect = 'http://localhost:3000';
const oauth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirect);
const url = oauth.generateAuthUrl({
  access_type: 'offline', prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/presentations'],
});
console.log('Ouvre cette URL et autorise l\'accès:\n' + url);
const server = http.createServer(async (req, res) => {
  const code = new URL(req.url, redirect).searchParams.get('code');
  if (!code) return res.end('pas de code');
  const { tokens } = await oauth.getToken(code);
  res.end('OK, retourne dans le terminal.');
  console.log('\nGOOGLE_REFRESH_TOKEN =', tokens.refresh_token);
  server.close();
});
server.listen(3000);
