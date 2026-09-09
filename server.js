require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fetch = require('node-fetch');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// Render/여러 호스팅은 프록시 뒤에서 동작하므로, 보안 쿠키(secure)가 제대로 동작하려면 필요
app.set('trust proxy', 1);

// ---------- 필수 환경변수 점검 ----------
// ADMIN 계정: 거래처 등록/수정/삭제까지 가능 (관리자/배차 담당자용)
// VIEWER 계정: 거래처 조회만 가능, 등록/수정/삭제 불가 (기사님용)
// DATABASE_URL: Neon(PostgreSQL) 연결 문자열 - 데이터가 여기에 영구 저장됩니다.
const REQUIRED_ENV = ['SESSION_SECRET', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'VIEWER_USERNAME', 'VIEWER_PASSWORD', 'DATABASE_URL'];
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
      // 네이버 지도 SDK가 스타일/타일 데이터를 여러 서브도메인(pstatic.net, map.naver.net 등)에 나눠서
      // 스크립트/네트워크 요청으로 불러오기 때문에, 도메인을 일일이 나열하는 대신 https 전체를 허용합니다.
      // (인라인 스크립트/데이터URL 스크립트 실행은 여전히 차단되어 최소한의 보호는 유지됩니다.)
      scriptSrc: ["'self'", 'https:'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https:'],
      fontSrc: ["'self'", 'https:', 'data:'],
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

// 로그인 페이지가 쓰는 스크립트도 인증 없이 접근 허용 (CSP 상 인라인 스크립트를 쓸 수 없어 별도 파일로 분리)
app.get('/login.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.js'));
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

// 비동기 라우트 핸들러의 에러를 자동으로 catch해서 에러 핸들러로 넘겨주는 헬퍼
function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function sanitizeText(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;

// ---------- 프론트엔드용 설정(공개 가능한 지도 클라이언트 ID만 전달) ----------
app.get('/api/config', (req, res) => {
  res.json({
    naverMapsClientId: process.env.NAVER_MAPS_CLIENT_ID || ''
  });
});

// ---------- 거래처 CRUD (모두 로그인 필요) ----------
app.get('/api/clients', asyncRoute(async (req, res) => {
  res.json(await db.getAllClients());
}));

app.post('/api/clients', requireAdmin, asyncRoute(async (req, res) => {
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

  const newClient = await db.createClient({
    id: genId(),
    name,
    address,
    manager,
    phone,
    memo,
    lat,
    lng
  });

  res.status(201).json(newClient);
}));

app.put('/api/clients/:id', requireAdmin, asyncRoute(async (req, res) => {
  const existing = await db.getClientById(req.params.id);
  if (!existing) return res.status(404).json({ error: '거래처를 찾을 수 없습니다.' });

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

  const updated = await db.updateClient(req.params.id, { name, address, manager, phone, memo, lat, lng });
  res.json(updated);
}));

app.delete('/api/clients/:id', requireAdmin, asyncRoute(async (req, res) => {
  const deleted = await db.deleteClient(req.params.id);
  if (!deleted) return res.status(404).json({ error: '거래처를 찾을 수 없습니다.' });
  res.status(204).end();
}));

// ---------- 배차 일정 (특정 날짜에 어떤 거래처를 어떤 순서로, 언제 갔는지) ----------
app.get('/api/schedule', asyncRoute(async (req, res) => {
  const date = req.query.date;
  if (!date || !DATE_PATTERN.test(date)) {
    return res.status(400).json({ error: '날짜 형식이 올바르지 않습니다 (YYYY-MM-DD).' });
  }

  const { startedAt, clients } = await db.getScheduleForDate(date);

  res.json({
    date,
    startedAt,
    clientIds: clients.map(c => c.id),
    clients
  });
}));

app.put('/api/schedule', requireAdmin, asyncRoute(async (req, res) => {
  const date = req.query.date;
  if (!date || !DATE_PATTERN.test(date)) {
    return res.status(400).json({ error: '날짜 형식이 올바르지 않습니다 (YYYY-MM-DD).' });
  }

  const clientIds = req.body?.clientIds;
  if (!Array.isArray(clientIds) || !clientIds.every(id => typeof id === 'string')) {
    return res.status(400).json({ error: 'clientIds는 문자열 배열이어야 합니다.' });
  }

  // 실제 존재하는 거래처 id만 저장 (중복 제거, 순서는 그대로 유지)
  const allClients = await db.getAllClients();
  const existingIds = new Set(allClients.map(c => c.id));
  const seen = new Set();
  const cleanIds = clientIds.filter(id => {
    if (!existingIds.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  await db.setScheduleItems(date, cleanIds);

  res.json({ date, clientIds: cleanIds });
}));

// 아침에 오늘 배차를 시작할 때 누르는 버튼 (관리자, 기사님 계정 모두 가능)
app.patch('/api/schedule/start', asyncRoute(async (req, res) => {
  const date = req.query.date;
  if (!date || !DATE_PATTERN.test(date)) {
    return res.status(400).json({ error: '날짜 형식이 올바르지 않습니다 (YYYY-MM-DD).' });
  }

  const startedAt = await db.startSchedule(date);
  res.json({ date, startedAt });
}));

// 납품 완료 체크 (관리자, 기사님 계정 모두 가능 - 순서 변경 권한과는 별개)
// 체크할 때마다 완료 시각이 기록되고, 이후 거래처들의 예상 도착시간 계산 기준이 바뀝니다.
app.patch('/api/schedule/complete', asyncRoute(async (req, res) => {
  const date = req.query.date;
  if (!date || !DATE_PATTERN.test(date)) {
    return res.status(400).json({ error: '날짜 형식이 올바르지 않습니다 (YYYY-MM-DD).' });
  }

  const { clientId, done } = req.body || {};
  if (typeof clientId !== 'string' || typeof done !== 'boolean') {
    return res.status(400).json({ error: 'clientId(문자열), done(boolean)이 필요합니다.' });
  }

  const completedAt = await db.setItemCompleted(date, clientId, done);
  if (completedAt === undefined) {
    return res.status(404).json({ error: '해당 날짜의 배차 목록에서 거래처를 찾을 수 없습니다.' });
  }

  res.json({ date, clientId, completedAt });
}));

// 그날 배차 항목의 메모(예: 납품 수량) 수정 - 관리자만 가능
app.patch('/api/schedule/note', requireAdmin, asyncRoute(async (req, res) => {
  const date = req.query.date;
  if (!date || !DATE_PATTERN.test(date)) {
    return res.status(400).json({ error: '날짜 형식이 올바르지 않습니다 (YYYY-MM-DD).' });
  }

  const { clientId } = req.body || {};
  if (typeof clientId !== 'string') {
    return res.status(400).json({ error: 'clientId(문자열)가 필요합니다.' });
  }

  const note = sanitizeText(req.body?.note, 200);

  const savedNote = await db.setItemNote(date, clientId, note);
  if (savedNote === undefined) {
    return res.status(404).json({ error: '해당 날짜의 배차 목록에서 거래처를 찾을 수 없습니다.' });
  }

  res.json({ date, clientId, note: savedNote });
}));

// 달력 화면에서 날짜별 배차 건수를 보여주기 위한 월별 집계 (모든 로그인 사용자 가능)
app.get('/api/schedule/month', asyncRoute(async (req, res) => {
  const month = req.query.month;
  if (!month || !MONTH_PATTERN.test(month)) {
    return res.status(400).json({ error: '월 형식이 올바르지 않습니다 (YYYY-MM).' });
  }

  const counts = await db.getScheduleCountsForMonth(month);
  res.json({ month, counts });
}));

// ---------- 네이버 지오코딩 ----------
async function geocodeAddress(address) {
  const clientId = process.env.NAVER_MAPS_CLIENT_ID;
  const clientSecret = process.env.NAVER_MAPS_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('서버에 NAVER_MAPS_CLIENT_ID / NAVER_MAPS_CLIENT_SECRET 환경변수가 설정되어 있지 않습니다.');
  }

  const url = `https://maps.apigw.ntruss.com/map-geocode/v2/geocode?query=${encodeURIComponent(address)}`;

  const response = await fetch(url, {
    headers: {
      'x-ncp-apigw-api-key-id': clientId,
      'x-ncp-apigw-api-key': clientSecret,
      'Accept': 'application/json'
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

// ---------- DB 테이블 준비 후 서버 시작 ----------
db.initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`거래처 관리 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
    });
  })
  .catch((err) => {
    console.error('[DB 연결 오류] 데이터베이스에 연결하지 못했습니다. DATABASE_URL 값을 확인하세요.');
    console.error(err);
    process.exit(1);
  });
