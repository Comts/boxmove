// ---------- 데이터베이스(PostgreSQL / Neon) 연결 및 헬퍼 ----------
// 기존에는 data/clients.json, data/schedule.json 파일에 데이터를 저장했지만,
// Render 무료 플랜은 서버가 재시작/슬립될 때마다 파일이 초기화되어 데이터가 사라지는 문제가 있었습니다.
// 이제는 Neon(무료 PostgreSQL)에 데이터를 저장해서, 서버가 재시작되어도 데이터가 유지됩니다.
const crypto = require('crypto');
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('[설정 오류] DATABASE_URL 환경변수가 설정되어 있지 않습니다. Neon에서 발급받은 연결 문자열을 등록하세요.');
  process.exit(1);
}

// Neon은 SSL 연결이 필수입니다.
const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

function genItemId() {
  return crypto.randomBytes(10).toString('hex');
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      manager TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      memo TEXT DEFAULT '',
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // 예전 스키마(차량 구분 없이 date만 있던 구조)가 남아있으면, 배차 관련 테이블만
  // 새 구조(차량 구분 + 같은 거래처 하루 중복 방문 지원)로 다시 만듭니다.
  // 거래처 목록(clients 테이블)은 전혀 건드리지 않습니다.
  const legacyCheck = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'schedule_days' AND column_name = 'vehicle'
  `);
  if (legacyCheck.rows.length === 0) {
    await pool.query('DROP TABLE IF EXISTS schedule_items');
    await pool.query('DROP TABLE IF EXISTS schedule_days');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schedule_days (
      date TEXT NOT NULL,
      vehicle TEXT NOT NULL,
      started_at TIMESTAMPTZ,
      PRIMARY KEY (date, vehicle)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schedule_items (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      vehicle TEXT NOT NULL,
      client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      position INT NOT NULL,
      completed_at TIMESTAMPTZ,
      note TEXT DEFAULT '',
      FOREIGN KEY (date, vehicle) REFERENCES schedule_days(date, vehicle) ON DELETE CASCADE
    );
  `);

  // 재고 관리: 회사 전체가 공유하는 품목별 수량 (거래처별이 아니라 회사 전체 재고 1개)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      quantity INT NOT NULL DEFAULT 0,
      unit TEXT DEFAULT '',
      memo TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // 품목을 특정 거래처와 연결해두면(선택 사항), 재고 화면에서 바로 "납품추가"로
  // 오늘 날짜 배차(달력의 "기타" 줄)에 그 거래처를 추가할 수 있습니다.
  await pool.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS client_id TEXT REFERENCES clients(id) ON DELETE SET NULL;`);

  // 게시판식 메모: 회사 전체가 공유해서 보는 공지/메모 (관리자만 작성, 누구나 조회)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bulletin_notes (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      author TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // 파렛트 관리: 파렛트를 신경써야 하는 거래처만 골라서 관리합니다.
  // 거래처마다 파렛트 종류를 최대 3가지까지 이름 붙여 따로 관리합니다(예: KPP, 자체파렛트 등).
  // 빈 문자열이면 그 슬롯은 사용하지 않는 것으로 취급합니다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pallet_clients (
      client_id TEXT PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
      type1_name TEXT NOT NULL DEFAULT '파렛트',
      type2_name TEXT DEFAULT '',
      type3_name TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // 파렛트 입출고 기록(이력). 거래처에 파렛트를 줄 때(출고)는 남은 수량이 늘고,
  // 거래처에서 회수할 때(입고)는 남은 수량이 줄어듭니다. 남은 수량은 이 이력의 합으로 계산합니다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pallet_entries (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES pallet_clients(client_id) ON DELETE CASCADE,
      type_slot INT NOT NULL,
      direction TEXT NOT NULL,
      quantity INT NOT NULL,
      entry_date TEXT NOT NULL,
      memo TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

function rowToClient(row) {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    manager: row.manager || '',
    phone: row.phone || '',
    memo: row.memo || '',
    lat: row.lat,
    lng: row.lng,
    createdAt: row.created_at
  };
}

// ---------- 거래처 ----------
async function getAllClients() {
  const { rows } = await pool.query('SELECT * FROM clients ORDER BY created_at ASC');
  return rows.map(rowToClient);
}

async function getClientById(id) {
  const { rows } = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
  return rows[0] ? rowToClient(rows[0]) : null;
}

async function createClient(client) {
  const { rows } = await pool.query(
    `INSERT INTO clients (id, name, address, manager, phone, memo, lat, lng)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [client.id, client.name, client.address, client.manager, client.phone, client.memo, client.lat, client.lng]
  );
  return rowToClient(rows[0]);
}

async function updateClient(id, fields) {
  const { rows } = await pool.query(
    `UPDATE clients
     SET name = $2, address = $3, manager = $4, phone = $5, memo = $6, lat = $7, lng = $8
     WHERE id = $1
     RETURNING *`,
    [id, fields.name, fields.address, fields.manager, fields.phone, fields.memo, fields.lat, fields.lng]
  );
  return rows[0] ? rowToClient(rows[0]) : null;
}

async function deleteClient(id) {
  const { rowCount } = await pool.query('DELETE FROM clients WHERE id = $1', [id]);
  return rowCount > 0;
}

// ---------- 배차 일정 (날짜 + 차량 단위) ----------
// 같은 거래처(예: 우리 회사)가 하루에 여러 번 나올 수 있으므로, 각 배차 항목은
// client_id가 아니라 고유한 item id로 구분합니다.
async function getScheduleForDate(date, vehicle) {
  const dayResult = await pool.query(
    'SELECT started_at FROM schedule_days WHERE date = $1 AND vehicle = $2',
    [date, vehicle]
  );
  const startedAt = dayResult.rows[0] ? dayResult.rows[0].started_at : null;

  // 삭제된 거래처가 있으면 자동으로 조인에서 제외됨(INNER JOIN)
  const itemsResult = await pool.query(
    `SELECT si.id AS item_id, si.completed_at, si.note, c.*
     FROM schedule_items si
     JOIN clients c ON c.id = si.client_id
     WHERE si.date = $1 AND si.vehicle = $2
     ORDER BY si.position ASC`,
    [date, vehicle]
  );

  const items = itemsResult.rows.map(row => ({
    itemId: row.item_id,
    ...rowToClient(row),
    completedAt: row.completed_at,
    note: row.note || ''
  }));

  return { startedAt, items };
}

// items: [{ itemId: string|null, clientId: string }, ...] (순서대로)
// itemId가 있고 기존에 존재하던 항목이면 완료시각/메모를 그대로 유지하고,
// itemId가 없으면(새로 추가된 항목) 새 id를 발급합니다. 같은 clientId가 여러 번 나와도 됩니다.
async function setScheduleItems(date, vehicle, items) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO schedule_days (date, vehicle, started_at) VALUES ($1, $2, NULL)
       ON CONFLICT (date, vehicle) DO NOTHING`,
      [date, vehicle]
    );

    const existing = await client.query(
      'SELECT id, completed_at, note FROM schedule_items WHERE date = $1 AND vehicle = $2',
      [date, vehicle]
    );
    const existingById = new Map(existing.rows.map(r => [r.id, { completedAt: r.completed_at, note: r.note }]));

    await client.query('DELETE FROM schedule_items WHERE date = $1 AND vehicle = $2', [date, vehicle]);

    if (items.length === 0) {
      await client.query('DELETE FROM schedule_days WHERE date = $1 AND vehicle = $2', [date, vehicle]);
    } else {
      // 같은 itemId가 요청에 중복으로 들어와도 기본키 충돌이 나지 않도록, 한 번 재사용한
      // itemId는 다시 재사용하지 않고 새 id를 발급합니다.
      const usedIds = new Set();
      for (let i = 0; i < items.length; i++) {
        const { itemId, clientId, note } = items[i];
        const prev = itemId && !usedIds.has(itemId) ? existingById.get(itemId) : null;
        const rowId = prev ? itemId : genItemId();
        usedIds.add(rowId);
        // 기존 항목이면 완료시각/메모를 그대로 유지합니다. 새 항목이면(예: 다른 날짜에서
        // 드래그로 옮겨온 경우) 요청에 담긴 메모를 그대로 살려서 저장합니다.
        const noteToUse = prev ? prev.note : (typeof note === 'string' ? note : '');
        await client.query(
          `INSERT INTO schedule_items (id, date, vehicle, client_id, position, completed_at, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [rowId, date, vehicle, clientId, i, prev ? prev.completedAt : null, noteToUse]
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function startSchedule(date, vehicle) {
  const startedAt = new Date().toISOString();
  await pool.query(
    `INSERT INTO schedule_days (date, vehicle, started_at) VALUES ($1, $2, $3)
     ON CONFLICT (date, vehicle) DO UPDATE SET started_at = EXCLUDED.started_at`,
    [date, vehicle, startedAt]
  );
  return startedAt;
}

async function setItemCompleted(itemId, done) {
  const completedAt = done ? new Date().toISOString() : null;
  const { rowCount } = await pool.query(
    `UPDATE schedule_items SET completed_at = $2 WHERE id = $1`,
    [itemId, completedAt]
  );
  return rowCount > 0 ? completedAt : undefined;
}

// 그날 배차 항목에 대한 메모(예: 납품 수량)를 저장
async function setItemNote(itemId, note) {
  const { rowCount } = await pool.query(
    `UPDATE schedule_items SET note = $2 WHERE id = $1`,
    [itemId, note]
  );
  return rowCount > 0 ? note : undefined;
}

// 달력 화면에서 각 날짜에 배차가 몇 건 있는지 표시하기 위한 월별 집계
// monthPrefix 예: '2026-09' -> 'YYYY-MM-DD'가 이 문자열로 시작하는 날짜들을 집계
// vehicle을 생략하면 모든 차량을 합친 건수를 반환합니다 (달력 탭은 차량 구분 없이 한번에 보여주므로).
async function getScheduleCountsForMonth(monthPrefix, vehicle) {
  const params = [`${monthPrefix}%`];
  let sql = 'SELECT date, COUNT(*)::int AS cnt FROM schedule_items WHERE date LIKE $1';
  if (vehicle) {
    sql += ' AND vehicle = $2';
    params.push(vehicle);
  }
  sql += ' GROUP BY date';

  const { rows } = await pool.query(sql, params);
  const counts = {};
  rows.forEach(row => { counts[row.date] = row.cnt; });
  return counts;
}

// ---------- 재고 관리 (회사 전체 공용, 품목별 수량) ----------
function rowToInventoryItem(row) {
  return {
    id: row.id,
    name: row.name,
    quantity: row.quantity,
    unit: row.unit || '',
    memo: row.memo || '',
    clientId: row.client_id || null,
    clientName: row.client_name || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function getAllInventoryItems() {
  const { rows } = await pool.query(`
    SELECT i.*, c.name AS client_name
    FROM inventory_items i
    LEFT JOIN clients c ON c.id = i.client_id
    ORDER BY i.created_at ASC
  `);
  return rows.map(rowToInventoryItem);
}

async function createInventoryItem(item) {
  const { rows } = await pool.query(
    `INSERT INTO inventory_items (id, name, quantity, unit, memo, client_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [item.id, item.name, item.quantity, item.unit, item.memo, item.clientId || null]
  );
  return rowToInventoryItem(rows[0]);
}

async function updateInventoryItem(id, fields) {
  const { rows } = await pool.query(
    `UPDATE inventory_items
     SET name = $2, quantity = $3, unit = $4, memo = $5, client_id = $6, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, fields.name, fields.quantity, fields.unit, fields.memo, fields.clientId || null]
  );
  return rows[0] ? rowToInventoryItem(rows[0]) : null;
}

// 목록 화면에서 +/- 버튼으로 수량만 빠르게 조정할 때 씁니다. 0 밑으로는 내려가지 않습니다.
async function adjustInventoryQuantity(id, delta) {
  const { rows } = await pool.query(
    `UPDATE inventory_items
     SET quantity = GREATEST(quantity + $2, 0), updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, delta]
  );
  return rows[0] ? rowToInventoryItem(rows[0]) : null;
}

async function deleteInventoryItem(id) {
  const { rowCount } = await pool.query('DELETE FROM inventory_items WHERE id = $1', [id]);
  return rowCount > 0;
}

// ---------- 게시판식 메모 (회사 전체 공용) ----------
function rowToBulletinNote(row) {
  return {
    id: row.id,
    content: row.content,
    author: row.author || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function getAllBulletinNotes() {
  const { rows } = await pool.query('SELECT * FROM bulletin_notes ORDER BY created_at DESC');
  return rows.map(rowToBulletinNote);
}

async function createBulletinNote(note) {
  const { rows } = await pool.query(
    `INSERT INTO bulletin_notes (id, content, author)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [note.id, note.content, note.author]
  );
  return rowToBulletinNote(rows[0]);
}

async function updateBulletinNote(id, content) {
  const { rows } = await pool.query(
    `UPDATE bulletin_notes SET content = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, content]
  );
  return rows[0] ? rowToBulletinNote(rows[0]) : null;
}

async function deleteBulletinNote(id) {
  const { rowCount } = await pool.query('DELETE FROM bulletin_notes WHERE id = $1', [id]);
  return rowCount > 0;
}

// ---------- 파렛트 관리 (파렛트를 신경써야 하는 거래처만 선택해서 관리) ----------
// 거래처별로 최대 3가지 파렛트 종류를 따로 관리하고, 종류별 남은 수량은
// 그 종류의 입출고 이력 합계로 계산합니다 (출고 - 입고 = 현재 거래처에 나가있는 수량).
async function getAllPalletClients() {
  const { rows } = await pool.query(`
    SELECT
      pc.client_id,
      c.name AS client_name,
      c.address AS client_address,
      pc.type1_name, pc.type2_name, pc.type3_name,
      COALESCE(SUM(CASE WHEN pe.type_slot = 1 AND pe.direction = 'out' THEN pe.quantity
                         WHEN pe.type_slot = 1 AND pe.direction = 'in' THEN -pe.quantity ELSE 0 END), 0)::int AS type1_remaining,
      COALESCE(SUM(CASE WHEN pe.type_slot = 2 AND pe.direction = 'out' THEN pe.quantity
                         WHEN pe.type_slot = 2 AND pe.direction = 'in' THEN -pe.quantity ELSE 0 END), 0)::int AS type2_remaining,
      COALESCE(SUM(CASE WHEN pe.type_slot = 3 AND pe.direction = 'out' THEN pe.quantity
                         WHEN pe.type_slot = 3 AND pe.direction = 'in' THEN -pe.quantity ELSE 0 END), 0)::int AS type3_remaining
    FROM pallet_clients pc
    JOIN clients c ON c.id = pc.client_id
    LEFT JOIN pallet_entries pe ON pe.client_id = pc.client_id
    GROUP BY pc.client_id, c.name, c.address, pc.type1_name, pc.type2_name, pc.type3_name
    ORDER BY c.name ASC
  `);

  return rows.map(row => ({
    clientId: row.client_id,
    clientName: row.client_name,
    clientAddress: row.client_address,
    types: [
      { slot: 1, name: row.type1_name || '', remaining: row.type1_remaining },
      { slot: 2, name: row.type2_name || '', remaining: row.type2_remaining },
      { slot: 3, name: row.type3_name || '', remaining: row.type3_remaining }
    ].filter(t => t.name) // 이름이 없는 슬롯은 사용하지 않는 것으로 취급
  }));
}

async function createPalletClient({ clientId, type1Name, type2Name, type3Name }) {
  const { rows } = await pool.query(
    `INSERT INTO pallet_clients (client_id, type1_name, type2_name, type3_name)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [clientId, type1Name || '파렛트', type2Name || '', type3Name || '']
  );
  return rows[0];
}

async function updatePalletClientTypes(clientId, { type1Name, type2Name, type3Name }) {
  const { rows } = await pool.query(
    `UPDATE pallet_clients SET type1_name = $2, type2_name = $3, type3_name = $4
     WHERE client_id = $1
     RETURNING *`,
    [clientId, type1Name || '파렛트', type2Name || '', type3Name || '']
  );
  return rows[0] || null;
}

async function deletePalletClient(clientId) {
  const { rowCount } = await pool.query('DELETE FROM pallet_clients WHERE client_id = $1', [clientId]);
  return rowCount > 0;
}

async function isPalletClient(clientId) {
  const { rows } = await pool.query('SELECT 1 FROM pallet_clients WHERE client_id = $1', [clientId]);
  return rows.length > 0;
}

async function getPalletEntries(clientId) {
  const { rows } = await pool.query(
    'SELECT * FROM pallet_entries WHERE client_id = $1 ORDER BY entry_date DESC, created_at DESC',
    [clientId]
  );
  return rows.map(row => ({
    id: row.id,
    clientId: row.client_id,
    typeSlot: row.type_slot,
    direction: row.direction,
    quantity: row.quantity,
    entryDate: row.entry_date,
    memo: row.memo || '',
    createdAt: row.created_at
  }));
}

async function createPalletEntry(entry) {
  await pool.query(
    `INSERT INTO pallet_entries (id, client_id, type_slot, direction, quantity, entry_date, memo)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [entry.id, entry.clientId, entry.typeSlot, entry.direction, entry.quantity, entry.entryDate, entry.memo]
  );
}

async function deletePalletEntry(id) {
  const { rowCount } = await pool.query('DELETE FROM pallet_entries WHERE id = $1', [id]);
  return rowCount > 0;
}

// 현재 DB(Postgres) 전체 용량(바이트). Neon 무료 플랜은 프로젝트당 0.5GB로 제한되어 있어서,
// 관리자 화면에 대략적인 사용량을 보여줘서 미리 알아챌 수 있게 합니다.
async function getDatabaseSizeBytes() {
  const { rows } = await pool.query('SELECT pg_database_size(current_database()) AS bytes');
  return Number(rows[0].bytes);
}

module.exports = {
  pool,
  initDb,
  getAllClients,
  getClientById,
  createClient,
  updateClient,
  deleteClient,
  getScheduleForDate,
  setScheduleItems,
  startSchedule,
  setItemCompleted,
  setItemNote,
  getScheduleCountsForMonth,
  getAllInventoryItems,
  createInventoryItem,
  updateInventoryItem,
  adjustInventoryQuantity,
  deleteInventoryItem,
  getAllBulletinNotes,
  createBulletinNote,
  updateBulletinNote,
  deleteBulletinNote,
  getAllPalletClients,
  createPalletClient,
  updatePalletClientTypes,
  deletePalletClient,
  isPalletClient,
  getPalletEntries,
  createPalletEntry,
  deletePalletEntry,
  getDatabaseSizeBytes
};
