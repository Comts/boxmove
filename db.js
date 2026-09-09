// ---------- 데이터베이스(PostgreSQL / Neon) 연결 및 헬퍼 ----------
// 기존에는 data/clients.json, data/schedule.json 파일에 데이터를 저장했지만,
// Render 무료 플랜은 서버가 재시작/슬립될 때마다 파일이 초기화되어 데이터가 사라지는 문제가 있었습니다.
// 이제는 Neon(무료 PostgreSQL)에 데이터를 저장해서, 서버가 재시작되어도 데이터가 유지됩니다.
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schedule_days (
      date TEXT PRIMARY KEY,
      started_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schedule_items (
      date TEXT NOT NULL REFERENCES schedule_days(date) ON DELETE CASCADE,
      client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      position INT NOT NULL,
      completed_at TIMESTAMPTZ,
      PRIMARY KEY (date, client_id)
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

// ---------- 배차 일정 ----------
async function getScheduleForDate(date) {
  const dayResult = await pool.query('SELECT started_at FROM schedule_days WHERE date = $1', [date]);
  const startedAt = dayResult.rows[0] ? dayResult.rows[0].started_at : null;

  // 순서(position) 기준으로 정렬해서 가져오고, 삭제된 거래처는 자동으로 조인에서 제외됨(INNER JOIN)
  const itemsResult = await pool.query(
    `SELECT c.*, si.completed_at
     FROM schedule_items si
     JOIN clients c ON c.id = si.client_id
     WHERE si.date = $1
     ORDER BY si.position ASC`,
    [date]
  );

  const clients = itemsResult.rows.map(row => ({
    ...rowToClient(row),
    completedAt: row.completed_at
  }));

  return { startedAt, clients };
}

async function setScheduleItems(date, clientIds) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 해당 날짜 행이 없으면 생성 (started_at은 건드리지 않음)
    await client.query(
      `INSERT INTO schedule_days (date, started_at) VALUES ($1, NULL)
       ON CONFLICT (date) DO NOTHING`,
      [date]
    );

    // 기존에 체크된 완료 시각은 유지해야 하므로 미리 조회
    const existing = await client.query(
      'SELECT client_id, completed_at FROM schedule_items WHERE date = $1',
      [date]
    );
    const previousCompletedAt = new Map(existing.rows.map(r => [r.client_id, r.completed_at]));

    await client.query('DELETE FROM schedule_items WHERE date = $1', [date]);

    if (clientIds.length === 0) {
      // 목록이 비었으면 해당 날짜 자체를 정리
      await client.query('DELETE FROM schedule_days WHERE date = $1', [date]);
    } else {
      for (let i = 0; i < clientIds.length; i++) {
        const clientId = clientIds[i];
        await client.query(
          `INSERT INTO schedule_items (date, client_id, position, completed_at)
           VALUES ($1, $2, $3, $4)`,
          [date, clientId, i, previousCompletedAt.get(clientId) || null]
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

async function startSchedule(date) {
  const startedAt = new Date().toISOString();
  await pool.query(
    `INSERT INTO schedule_days (date, started_at) VALUES ($1, $2)
     ON CONFLICT (date) DO UPDATE SET started_at = EXCLUDED.started_at`,
    [date, startedAt]
  );
  return startedAt;
}

async function setItemCompleted(date, clientId, done) {
  const completedAt = done ? new Date().toISOString() : null;
  const { rowCount } = await pool.query(
    `UPDATE schedule_items SET completed_at = $3
     WHERE date = $1 AND client_id = $2`,
    [date, clientId, completedAt]
  );
  return rowCount > 0 ? completedAt : undefined;
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
  setItemCompleted
};
