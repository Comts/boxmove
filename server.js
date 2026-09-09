require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
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
// VIEWER 계정: 거래처 조회만 가능, 등록/수정/삭제 불가 (기사님용) - 차량별로 계정이 따로 있습니다.
//   VIEWER_35T_* 로 로그인하면 3.5t 차량 기사님, VIEWER_5T_* 로 로그인하면 5t 차량 기사님으로 인식되어
//   로그인 직후 각자 본인 차량의 "오늘의 배차"만 바로 보여줍니다.
// DATABASE_URL: Neon(PostgreSQL) 연결 문자열 - 데이터가 여기에 영구 저장됩니다.
const REQUIRED_ENV = [
  'SESSION_SECRET',
  'ADMIN_USERNAME', 'ADMIN_PASSWORD',
  'VIEWER_35T_USERNAME', 'VIEWER_35T_PASSWORD',
  'VIEWER_5T_USERNAME', 'VIEWER_5T_PASSWORD',
  'DATABASE_URL'
];
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
// 세션을 메모리(MemoryStore)가 아니라 Neon(PostgreSQL)에 저장합니다.
// 예전에는 서버가 재시작/슬립될 때마다(Render 무료 플랜은 자주 발생) 메모리에 있던 로그인 정보가
// 통째로 사라져서, 기사님들이 계속 다시 로그인해야 하는 문제가 있었습니다. DB에 저장하면 서버가
// 재시작되어도 로그인이 유지됩니다. 세션 테이블은 최초 실행 시 자동으로 만들어집니다.
app.use(session({
  store: new pgSession({
    pool: db.pool,
    tableName: 'user_sessions',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET,
  name: 'transport.sid',
  resave: false,
  saveUninitialized: false,
  rolling: true, // 사용할 때마다 만료시간을 30일로 다시 늘려줘서, 계속 쓰는 한 로그아웃되지 않습니다.
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd, // 배포(HTTPS) 환경에서는 true, 로컬 http 테스트에서는 false
    maxAge: 1000 * 60 * 60 * 24 * 30 // 30일 (계속 사용하면 rolling 옵션으로 매번 갱신됨)
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

// 로그인 성공 시 { role, vehicle } 형태로 반환합니다.
// role: 'admin' | 'viewer', vehicle: 기사님 계정이면 자신이 모는 차량('3.5t'|'5t'), 관리자는 null(차량 제한 없음)
function matchAccount(username, password) {
  const isAdmin = timingSafeEqual(username, process.env.ADMIN_USERNAME) &&
    timingSafeEqual(password, process.env.ADMIN_PASSWORD);
  if (isAdmin) return { role: 'admin', vehicle: null };

  const is35t = timingSafeEqual(username, process.env.VIEWER_35T_USERNAME) &&
    timingSafeEqual(password, process.env.VIEWER_35T_PASSWORD);
  if (is35t) return { role: 'viewer', vehicle: '3.5t' };

  const is5t = timingSafeEqual(username, process.env.VIEWER_5T_USERNAME) &&
    timingSafeEqual(password, process.env.VIEWER_5T_PASSWORD);
  if (is5t) return { role: 'viewer', vehicle: '5t' };

  return null;
}

app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요.' });
  }

  const account = matchAccount(username, password);

  if (!account) {
    return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: '로그인 처리 중 오류가 발생했습니다.' });
    req.session.loggedIn = true;
    req.session.username = username;
    req.session.role = account.role;
    req.session.vehicle = account.vehicle;
    res.json({ ok: true, role: account.role, vehicle: account.vehicle });
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
    role: req.session?.role || null,
    vehicle: req.session?.vehicle || null
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

// 보유 차량 목록 (2대: 3.5t, 5t). 차량이 늘어나면 이 배열에만 추가하면 됩니다.
const VEHICLES = ['3.5t', '5t'];
function isValidVehicle(v) {
  return typeof v === 'string' && VEHICLES.includes(v);
}

// ---------- 프론트엔드용 설정(공개 가능한 지도 클라이언트 ID만 전달) ----------
app.get('/api/config', (req, res) => {
  res.json({
    naverMapsClientId: process.env.NAVER_MAPS_CLIENT_ID || ''
  });
});

app.get('/api/vehicles', (req, res) => {
  res.json({ vehicles: VEHICLES });
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

// ---------- 배차 일정 (날짜 + 차량마다 어떤 거래처를 어떤 순서로, 언제 갔는지) ----------
// 같은 거래처(예: 우리 회사 주소)가 하루에 여러 번 나올 수 있어서, 각 배차 항목은
// itemId라는 고유 값으로 구분합니다 (거래처 id가 같아도 상관없음).
app.get('/api/schedule', asyncRoute(async (req, res) => {
  const date = req.query.date;
  const vehicle = req.query.vehicle;
  if (!date || !DATE_PATTERN.test(date)) {
    return res.status(400).json({ error: '날짜 형식이 올바르지 않습니다 (YYYY-MM-DD).' });
  }
  if (!isValidVehicle(vehicle)) {
    return res.status(400).json({ error: '차량 종류가 올바르지 않습니다.' });
  }

  const { startedAt, items } = await db.getScheduleForDate(date, vehicle);

  res.json({ date, vehicle, startedAt, items });
}));

app.put('/api/schedule', requireAdmin, asyncRoute(async (req, res) => {
  const date = req.query.date;
  const vehicle = req.query.vehicle;
  if (!date || !DATE_PATTERN.test(date)) {
    return res.status(400).json({ error: '날짜 형식이 올바르지 않습니다 (YYYY-MM-DD).' });
  }
  if (!isValidVehicle(vehicle)) {
    return res.status(400).json({ error: '차량 종류가 올바르지 않습니다.' });
  }

  const rawItems = req.body?.items;
  if (!Array.isArray(rawItems)) {
    return res.status(400).json({ error: 'items 배열이 필요합니다.' });
  }

  // 실제 존재하는 거래처만 허용 (같은 거래처가 여러 번 나오는 것은 허용)
  const allClients = await db.getAllClients();
  const existingIds = new Set(allClients.map(c => c.id));
  const cleanItems = rawItems
    .filter(it => it && typeof it.clientId === 'string' && existingIds.has(it.clientId))
    .map(it => ({
      itemId: typeof it.itemId === 'string' ? it.itemId : null,
      clientId: it.clientId,
      // 기존 항목의 메모는 서버에서 항상 그대로 유지되고, 이 값은 새 항목(다른 날짜에서
      // 옮겨온 경우 등)일 때만 초기 메모로 사용됩니다.
      note: typeof it.note === 'string' ? sanitizeText(it.note, 200) : ''
    }));

  await db.setScheduleItems(date, vehicle, cleanItems);

  const { startedAt, items } = await db.getScheduleForDate(date, vehicle);
  res.json({ date, vehicle, startedAt, items });
}));

// 아침에 오늘 배차를 시작할 때 누르는 버튼 (관리자, 기사님 계정 모두 가능)
// 기사님 계정은 화면에서 애초에 본인 차량만 보이지만, 혹시 다른 차량 값으로 직접 요청을 보내더라도
// 서버에서 본인 차량이 아니면 차단합니다.
app.patch('/api/schedule/start', asyncRoute(async (req, res) => {
  const date = req.query.date;
  const vehicle = req.query.vehicle;
  if (!date || !DATE_PATTERN.test(date)) {
    return res.status(400).json({ error: '날짜 형식이 올바르지 않습니다 (YYYY-MM-DD).' });
  }
  if (!isValidVehicle(vehicle)) {
    return res.status(400).json({ error: '차량 종류가 올바르지 않습니다.' });
  }
  if (req.session.role === 'viewer' && req.session.vehicle !== vehicle) {
    return res.status(403).json({ error: '본인 차량의 배차만 시작할 수 있습니다.' });
  }

  const startedAt = await db.startSchedule(date, vehicle);
  res.json({ date, vehicle, startedAt });
}));

// 납품 완료 체크 (관리자, 기사님 계정 모두 가능 - 순서 변경 권한과는 별개)
// 체크할 때마다 완료 시각이 기록되고, 이후 거래처들의 예상 도착시간 계산 기준이 바뀝니다.
// itemId로 항목을 특정하므로 날짜/차량 파라미터는 필요 없습니다.
app.patch('/api/schedule/complete', asyncRoute(async (req, res) => {
  const { itemId, done } = req.body || {};
  if (typeof itemId !== 'string' || typeof done !== 'boolean') {
    return res.status(400).json({ error: 'itemId(문자열), done(boolean)이 필요합니다.' });
  }

  const completedAt = await db.setItemCompleted(itemId, done);
  if (completedAt === undefined) {
    return res.status(404).json({ error: '해당 배차 항목을 찾을 수 없습니다.' });
  }

  res.json({ itemId, completedAt });
}));

// 그날 배차 항목의 메모(예: 납품 수량) 수정 - 관리자만 가능
app.patch('/api/schedule/note', requireAdmin, asyncRoute(async (req, res) => {
  const { itemId } = req.body || {};
  if (typeof itemId !== 'string') {
    return res.status(400).json({ error: 'itemId(문자열)가 필요합니다.' });
  }

  const note = sanitizeText(req.body?.note, 200);

  const savedNote = await db.setItemNote(itemId, note);
  if (savedNote === undefined) {
    return res.status(404).json({ error: '해당 배차 항목을 찾을 수 없습니다.' });
  }

  res.json({ itemId, note: savedNote });
}));

// 달력 화면에서 날짜별 배차 건수를 보여주기 위한 월별 집계 (모든 로그인 사용자 가능)
// 달력 탭은 차량 구분 없이 한 번에 보여주므로, vehicle 파라미터는 생략하면 전체 차량 합계를 반환합니다.
app.get('/api/schedule/month', asyncRoute(async (req, res) => {
  const month = req.query.month;
  const vehicle = req.query.vehicle;
  if (!month || !MONTH_PATTERN.test(month)) {
    return res.status(400).json({ error: '월 형식이 올바르지 않습니다 (YYYY-MM).' });
  }
  if (vehicle !== undefined && !isValidVehicle(vehicle)) {
    return res.status(400).json({ error: '차량 종류가 올바르지 않습니다.' });
  }

  const counts = await db.getScheduleCountsForMonth(month, vehicle);
  res.json({ month, vehicle: vehicle || null, counts });
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
