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
const SCHEDULE_FILE = path.join(__dirname, 'data', 'schedule.json');
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

// ---------- 배차 일정 데이터 헬퍼 ----------
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function readSchedule() {
  try {
    const raw = fs.readFileSync(SCHEDULE_FILE, 'utf-8');
    return JSON.parse(raw || '{}');
  } catch (err) {
    return {};
  }
}

function writeSchedule(schedule) {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2), 'utf-8');
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

// ---------- 배차 일정 (특정 날짜에 어떤 거래처를 어떤 순서로, 언제 갔는지) ----------
// 저장 형식: schedule[date] = { startedAt: ISO문자열|null, items: [{ clientId, completedAt: ISO문자열|null }] }
// (예전 형식들도 계속 읽을 수 있도록 호환 처리)
function normalizeScheduleEntry(rawEntry) {
  if (!rawEntry) return { startedAt: null, items: [] };

  const rawItems = Array.isArray(rawEntry) ? rawEntry : rawEntry.items;
  const startedAt = Array.isArray(rawEntry) ? null : (rawEntry.startedAt || null);

  const items = (Array.isArray(rawItems) ? rawItems : []).map(item => {
    if (typeof item === 'string') return { clientId: item, completedAt: null };
    return {
      clientId: item.clientId,
      completedAt: item.completedAt || (item.done ? new Date(0).toISOString() : null)
    };
  });

  return { startedAt, items };
}

app.get('/api/schedule', (req, res) => {
  const date = req.query.date;
  if (!date || !DATE_PATTERN.test(date)) {
    return res.status(400).json({ error: '날짜 형식이 올바르지 않습니다 (YYYY-MM-DD).' });
  }

  const schedule = readSchedule();
  const entry = normalizeScheduleEntry(schedule[date]);
  const clients = readClients();
  const clientById = Object.fromEntries(clients.map(c => [c.id, c]));

  // 순서를 유지하면서, 이미 삭제된 거래처는 목록에서 자동으로 제외
  const orderedClients = entry.items
    .filter(item => clientById[item.clientId])
    .map(item => ({ ...clientById[item.clientId], completedAt: item.completedAt }));

  res.json({
    date,
    startedAt: entry.startedAt,
    clientIds: orderedClients.map(c => c.id),
    clients: orderedClients
  });
});

app.put('/api/schedule', requireAdmin, (req, res) => {
  const date = req.query.date;
  if (!date || !DATE_PATTERN.test(date)) {
    return res.status(400).json({ error: '날짜 형식이 올바르지 않습니다 (YYYY-MM-DD).' });
  }

  const clientIds = req.body?.clientIds;
  if (!Array.isArray(clientIds) || !clientIds.every(id => typeof id === 'string')) {
    return res.status(400).json({ error: 'clientIds는 문자열 배열이어야 합니다.' });
  }

  // 실제 존재하는 거래처 id만 저장 (중복 제거, 순서는 그대로 유지)
  const existingIds = new Set(readClients().map(c => c.id));
  const seen = new Set();
  const cleanIds = clientIds.filter(id => {
    if (!existingIds.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const schedule = readSchedule();
  const existingEntry = normalizeScheduleEntry(schedule[date]);
  // 기존에 체크되어 있던 완료 시각은 그대로 유지하고, 새로 추가된 거래처만 완료 전 상태로 시작
  const previousCompletedAt = new Map(existingEntry.items.map(item => [item.clientId, item.completedAt]));
  const newItems = cleanIds.map(clientId => ({ clientId, completedAt: previousCompletedAt.get(clientId) || null }));

  if (newItems.length === 0) {
    delete schedule[date];
  } else {
    schedule[date] = { startedAt: existingEntry.startedAt, items: newItems };
  }
  writeSchedule(schedule);

  res.json({ date, clientIds: cleanIds });
});

// 아침에 오늘 배차를 시작할 때 누르는 버튼 (관리자, 기사님 계정 모두 가능)
app.patch('/api/schedule/start', (req, res) => {
  const date = req.query.date;
  if (!date || !DATE_PATTERN.test(date)) {
    return res.status(400).json({ error: '날짜 형식이 올바르지 않습니다 (YYYY-MM-DD).' });
  }

  const schedule = readSchedule();
  const entry = normalizeScheduleEntry(schedule[date]);
  entry.startedAt = new Date().toISOString();
  schedule[date] = entry;
  writeSchedule(schedule);

  res.json({ date, startedAt: entry.startedAt });
});

// 납품 완료 체크 (관리자, 기사님 계정 모두 가능 - 순서 변경 권한과는 별개)
// 체크할 때마다 완료 시각이 기록되고, 이후 거래처들의 예상 도착시간 계산 기준이 바뀝니다.
app.patch('/api/schedule/complete', (req, res) => {
  const date = req.query.date;
  if (!date || !DATE_PATTERN.test(date)) {
    return res.status(400).json({ error: '날짜 형식이 올바르지 않습니다 (YYYY-MM-DD).' });
  }

  const { clientId, done } = req.body || {};
  if (typeof clientId !== 'string' || typeof done !== 'boolean') {
    return res.status(400).json({ error: 'clientId(문자열), done(boolean)이 필요합니다.' });
  }

  const schedule = readSchedule();
  const entry = normalizeScheduleEntry(schedule[date]);
  const target = entry.items.find(item => item.clientId === clientId);

  if (!target) {
    return res.status(404).json({ error: '해당 날짜의 배차 목록에서 거래처를 찾을 수 없습니다.' });
  }

  target.completedAt = done ? new Date().toISOString() : null;
  schedule[date] = entry;
  writeSchedule(schedule);

  res.json({ date, clientId, completedAt: target.completedAt });
});

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

app.listen(PORT, () => {
  console.log(`거래처 관리 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});
