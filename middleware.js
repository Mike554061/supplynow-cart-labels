// SupplyNow site gate — Vercel Routing Middleware (Node.js runtime), runs on every request.
// One shared password (env GATE_PASSWORD) -> signed 30-day cookie (env GATE_SECRET). No accounts needed.
// Log out: visit /__logout
import { next } from '@vercel/functions';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const config = { runtime: 'nodejs' };

const COOKIE = 'sn_gate';
const DAYS = 30;

const sign = (s, secret) => createHmac('sha256', secret).update(s).digest('base64url');
const safeEq = (a, b) => {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && timingSafeEqual(A, B);
};
const cookie = (req) => {
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)sn_gate=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
};
const valid = (req, secret) => {
  const [exp, sig] = cookie(req).split('.');
  return !!exp && !!sig && Number(exp) > Date.now() && safeEq(sign(exp, secret), sig);
};
const safeNext = (v) => { v = String(v || '/'); return v.startsWith('/') && !v.startsWith('//') ? v : '/'; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const page = (msg, to) => new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SupplyNow — sign in</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f14;color:#e8edf2;font:16px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  form{width:min(92vw,360px);padding:28px 24px;border:1px solid #1f2a36;border-radius:14px;background:#111821}
  h1{font-size:18px;margin:0 0 4px;letter-spacing:.04em}
  p{margin:0 0 18px;color:#8da2b5;font-size:14px}
  input{width:100%;box-sizing:border-box;padding:12px 14px;border-radius:10px;border:1px solid #2a3a4a;background:#0b0f14;color:#fff;font-size:17px}
  button{width:100%;margin-top:12px;padding:12px;border:0;border-radius:10px;background:#44e5c4;color:#06231c;font-weight:700;font-size:16px}
  .err{color:#ff8a8a;font-size:14px;margin-top:10px}
</style></head><body>
<form method="post" action="/__gate" autocomplete="on">
  <h1>SupplyNow</h1><p>Team access only. Enter the site password.</p>
  <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
  <input type="hidden" name="next" value="${esc(to)}">
  <button type="submit">Enter</button>
  ${msg ? `<div class="err">${esc(msg)}</div>` : ''}
</form></body></html>`, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

export default async function middleware(req) {
  const secret = process.env.GATE_SECRET, password = process.env.GATE_PASSWORD;
  if (!secret || !password) return new Response('Site gate is not configured (GATE_PASSWORD / GATE_SECRET).', { status: 503 });
  const url = new URL(req.url);
  if (url.pathname === '/__gate' && req.method === 'POST') {
    const form = await req.formData();
    const to = safeNext(form.get('next'));
    if (!safeEq(form.get('password') || '', password)) return page('That password did not match.', to);
    const exp = String(Date.now() + DAYS * 864e5);
    return new Response(null, { status: 303, headers: {
      Location: to,
      'Set-Cookie': `${COOKIE}=${encodeURIComponent(exp + '.' + sign(exp, secret))}; Path=/; Max-Age=${DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`,
    } });
  }
  if (url.pathname === '/__logout') {
    return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
  }
  if (valid(req, secret)) return next();
  return page('', url.pathname + url.search);
}
