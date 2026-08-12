require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'clients.json');
const isProd = process.env.NODE_ENV === 'production';

// Render/여러 호스팅은 프록시 뒤에서 동작하므로, 보안 쿠키(secure)가 제대로 동작하려면 필요
app.set('trust proxy', 1);

// ---------- 필수 환경변수 점검 ----------
// ADMIN 계정: 거래처 등록/수정/삭제까지 가능 (관리자/배차 담당자용)
// VIEWER 계정: 거래처 조회만 가능, 등록/수정/삭제 불가 (기사님용)
const REQUIRED_ENV = ['SESSION_SECRET', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'VIEWER_USERNAME', 'VIEWER_PASSWORD'];
const missingEnv = REQUIRED_ENV.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(`[보안 설정 오류] 다음 환경변수가 설정되지 않았습니다: ${missingEnv.join(', ')}`);
  console.error('.env 파일(로컬) 또는 호스팅의 Environment 설정(배포)에 값을 추가한 뒤 다시 시작하세요.');
  process.exit(1);
}

// ---------- 보안 헤더 ----------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://oapi.map.naver.com', 'https://openapi.map.naver.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://oapi.map.naver.com', 'https://openapi.map.naver.com', 'https://naveropenapi.apigw.ntruss.com'],
      frameSrc: ["'self'", 'https://oapi.map.naver.com', 'https://openapi.map.naver.com']
    }
  }
}));

app.use(express.json({ limit: '20kb' }));

// ---------- 세션 ----------
app.use(session({
  secret: process.env.SESSION_SECRET,
  name: 'transport.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd, // 배포(HTTPS) 환경에서는 true, 로컬 http 테스트에서는 false
    maxAge: 1000 * 60 * 60 * 8 // 8시간
  }
}));

// ---------- 로그인 시도 제한 (무차별 대입 공격 방지) ----------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '로그인 시도가 너무 많습니다. 15분 후 다시 시도해주세요.' }
});

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // 길이가 다르면 즉시 false지만, 타이밍 공격 방지를 위해 동일 길이 버퍼로 비교 수행
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function matchAccount(username, password) {
  const isAdmin = timingSafeEqual(username, process.env.ADMIN_USERNAME) &&
    timingSafeEqual(password, process.env.ADMIN_PASSWORD);
  if (isAdmin) return 'admin';

  const isViewer = timingSafeEqual(username, process.env.VIEWER_USERNAME) &&
    timingSafeEqual(password, process.env.VIEWER_PASSWORD);
  if (isViewer) return 'viewer';

  return null;
}

app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요.' });
  }

  const role = matchAccount(username, password);

  if (!role) {
    return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: '로그인 처리 중 오류가 발생했습니다.' });
    req.session.loggedIn = true;
    req.session.username = username;
    req.session.role = role;
    res.json({ ok: true, role });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('transport.sid');
    res.json({ ok: true });
  });
});

app.get('/api/me', (req, res) => {
  res.json({
    loggedIn: !!(req.session && req.session.loggedIn),
    username: req.session?.username || null,
    role: req.session?.role || null
  });
});

// ---------- 로그인 페이지는 인증 없이 접근 허용 ----------
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ---------- 이 아래는 전부 로그인 필요 ----------
function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  if (req.path.startsWith('/api')) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }
  return res.redirect('/login');
}

app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 등록/수정/삭제는 관리자 계정만 허용 (기사님 계정은 조회만 가능) ----------
function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  return res.status(403).json({ error: '이 작업은 관리자 계정만 할 수 있습니다.' });
}

// ---------- 데이터 헬퍼 ----------
function readClients() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(raw || '[]');
  } catch (err) {
    return [];
  }
}

function writeClients(clients) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(clients, null, 2), 'utf-8');
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function sanitizeText(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

// ---------- 프론트엔드용 설정(공개 가능한 지도 클라이언트 ID만 전달) ----------
app.get('/api/config', (req, res) => {
  res.json({
    naverMapsClientId: process.env.NAVER_MAPS_CLIENT_ID || ''
  });
});

// ---------- 거래처 CRUD (모두 로그인 필요) ----------
app.get('/api/clients', (req, res) => {
  res.json(readClients());
});

app.post('/api/clients', requireAdmin, async (req, res) => {
  const name = sanitizeText(req.body?.name, 100);
  const address = sanitizeText(req.body?.address, 200);
  const manager = sanitizeText(req.body?.manager, 50);
  const phone = sanitizeText(req.body?.phone, 30);
  const memo = sanitizeText(req.body?.memo, 500);

  if (!name || !address) {
    return res.status(400).json({ error: '회사명과 주소는 필수입니다.' });
  }

  let lat = null;
  let lng = null;

  try {
    const coords = await geocodeAddress(address);
    lat = coords.lat;
    lng = coords.lng;
  } catch (err) {
    return res.status(400).json({ error: `주소를 좌표로 변환하지 못했습니다: ${err.message}` });
  }

  const clients = readClients();
  const newClient = {
    id: genId(),
    name,
    address,
    manager,
    phone,
    memo,
    lat,
    lng,
    createdAt: new Date().toISOString()
  };

  clients.push(newClient);
  writeClients(clients);
  res.status(201).json(newClient);
});

app.put('/api/clients/:id', requireAdmin, async (req, res) => {
  const clients = readClients();
  const idx = clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '거래처를 찾을 수 없습니다.' });

  const existing = clients[idx];
  const name = req.body?.name !== undefined ? sanitizeText(req.body.name, 100) : existing.name;
  const address = req.body?.address !== undefined ? sanitizeText(req.body.address, 200) : existing.address;
  const manager = req.body?.manager !== undefined ? sanitizeText(req.body.manager, 50) : existing.manager;
  const phone = req.body?.phone !== undefined ? sanitizeText(req.body.phone, 30) : existing.phone;
  const memo = req.body?.memo !== undefined ? sanitizeText(req.body.memo, 500) : existing.memo;

  let lat = existing.lat;
  let lng = existing.lng;

  if (address && address !== existing.address) {
    try {
      const coords = await geocodeAddress(address);
      lat = coords.lat;
      lng = coords.lng;
    } catch (err) {
      return res.status(400).json({ error: `주소를 좌표로 변환하지 못했습니다: ${err.message}` });
    }
  }

  clients[idx] = { ...existing, name, address, manager, phone, memo, lat, lng };

  writeClients(clients);
  res.json(clients[idx]);
});

app.delete('/api/clients/:id', requireAdmin, (req, res) => {
  const clients = readClients();
  const filtered = clients.filter(c => c.id !== req.params.id);
  if (filtered.length === clients.length) {
    return res.status(404).json({ error: '거래처를 찾을 수 없습니다.' });
  }
  writeClients(filtered);
  res.status(204).end();
});

// ---------- 네이버 지오코딩 ----------
async function geocodeAddress(address) {
  const clientId = process.env.NAVER_MAPS_CLIENT_ID;
  const clientSecret = process.env.NAVER_MAPS_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('서버에 NAVER_MAPS_CLIENT_ID / NAVER_MAPS_CLIENT_SECRET 환경변수가 설정되어 있지 않습니다.');
  }

  const url = `https://naveropenapi.apigw.ntruss.com/map-geocode/v2/geocode?query=${encodeURIComponent(address)}`;

  const response = await fetch(url, {
    headers: {
      'X-NCP-APIGW-API-KEY-ID': clientId,
      'X-NCP-APIGW-API-KEY-SECRET': clientSecret
    }
  });

  if (!response.ok) {
    throw new Error(`네이버 지오코딩 API 오류 (${response.status})`);
  }

  const data = await response.json();

  if (!data.addresses || data.addresses.length === 0) {
    throw new Error('입력한 주소를 찾을 수 없습니다. 주소를 다시 확인해주세요.');
  }

  const first = data.addresses[0];
  return { lat: parseFloat(first.y), lng: parseFloat(first.x) };
}

// ---------- 에러 핸들러 (스택트레이스 등 민감정보 노출 방지) ----------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: '서버 오류가 발생했습니다.' });
});

app.listen(PORT, () => {
  console.log(`거래처 관리 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});
