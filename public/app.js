let map = null;
let markers = [];
let clients = [];
let editingId = null;
let currentRole = null; // 'admin' | 'viewer'
let activeTab = 'clients'; // 'clients' | 'schedule' | 'calendar'

// 차량 선택 (차량별로 배차가 완전히 분리됩니다)
const VEHICLES = ['3.5t', '5t'];
let selectedVehicle = localStorage.getItem('selectedVehicle') || VEHICLES[0];

// 배차 일정 상태 (같은 거래처가 하루에 여러 번 나올 수 있어 itemId로 각 항목을 구분합니다)
let scheduleDate = todayDateString();
let scheduleItems = []; // [{ itemId, id(=거래처id), name, address, lat, lng, completedAt, note, ... }]
let scheduleStartedAt = null; // 오늘 배차를 시작한 시각 (ISO 문자열, 시작 전이면 null)
let scheduleMarkers = [];
let schedulePolyline = null;

// 다음 거래처까지 예상 이동시간 계산에 사용하는 평균 주행 속도(도심/근거리 배송 기준 대략적인 값)
const AVG_SPEED_KMH = 30;

// 달력 탭 상태 (지도 없이 날짜별 배차 목록만 보는 화면)
let calendarMonth = todayDateString().slice(0, 7); // 'YYYY-MM'
let calendarSelectedDate = todayDateString();
let calendarWeekDates = []; // 선택한 날짜가 속한 주(일~토) 7개 날짜
let calendarWeekData = new Map(); // date -> { items: [...] }
let calendarCounts = {}; // { 'YYYY-MM-DD': 건수 }
let calDragIndex = null;
let calDragDate = null;

const el = id => document.getElementById(id);

function todayDateString() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function init() {
  const me = await fetchJSON('/api/me');
  currentRole = me.role;

  const config = await fetchJSON('/api/config');
  await loadNaverMapsScript(config.naverMapsClientId);
  initMap();
  await refreshClients();
  bindEvents();

  applyRoleUI();
  applyVehicleUI();

  // 기사님 계정은 로그인하면 바로 오늘의 배차 화면부터 보여줍니다.
  switchTab(currentRole === 'viewer' ? 'schedule' : 'clients');
}

function applyRoleUI() {
  const isAdmin = currentRole === 'admin';
  el('addBtn').classList.toggle('hidden', !isAdmin);
  el('scheduleAddBox').classList.toggle('hidden', !isAdmin);

  const badge = el('roleBadge');
  if (badge) {
    badge.textContent = isAdmin ? '관리자' : '조회 전용';
  }
}

// 화면에 있는 모든 차량 선택 버튼(오늘의 배차 탭, 달력 탭 각각)의 활성 표시를 동기화
function applyVehicleUI() {
  document.querySelectorAll('.vehicle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.vehicle === selectedVehicle);
  });
}

function setSelectedVehicle(vehicle) {
  if (vehicle === selectedVehicle) return;
  selectedVehicle = vehicle;
  localStorage.setItem('selectedVehicle', vehicle);
  applyVehicleUI();

  if (activeTab === 'schedule') {
    loadSchedule(scheduleDate);
  } else if (activeTab === 'calendar') {
    loadCalendarMonth(calendarMonth);
    selectCalendarDate(calendarSelectedDate);
  }
}

function loadNaverMapsScript(clientId) {
  return new Promise((resolve, reject) => {
    if (!clientId) {
      showToast('네이버 지도 API 키가 설정되지 않았습니다. .env 파일을 확인하세요.');
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${clientId}`;
    script.onload = resolve;
    script.onerror = () => {
      showToast('네이버 지도를 불러오지 못했습니다.');
      resolve();
    };
    document.head.appendChild(script);
  });
}

function initMap() {
  if (!window.naver) return;
  map = new naver.maps.Map('map', {
    center: new naver.maps.LatLng(36.5, 127.8),
    zoom: 7
  });
}

async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('로그인이 필요합니다.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `요청 실패 (${res.status})`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function refreshClients() {
  clients = await fetchJSON('/api/clients');
  if (activeTab === 'clients') renderMarkers();
  renderList();
  populateScheduleAddSelect();
}

function clearMarkers() {
  markers.forEach(m => m.setMap(null));
  markers = [];
}

function renderMarkers() {
  if (!window.naver || !map) return;
  clearScheduleMap();
  clearMarkers();

  const bounds = new naver.maps.LatLngBounds();
  let hasPoint = false;

  clients.forEach(client => {
    if (client.lat == null || client.lng == null) return;
    const position = new naver.maps.LatLng(client.lat, client.lng);
    const marker = new naver.maps.Marker({ position, map, title: client.name });

    const infoWindow = new naver.maps.InfoWindow({
      content: `<div style="padding:10px 12px; font-size:13px; line-height:1.5;">
        <strong>${escapeHtml(client.name)}</strong><br/>
        ${escapeHtml(client.address)}<br/>
        ${client.manager ? '담당자: ' + escapeHtml(client.manager) + '<br/>' : ''}
        ${client.phone ? '연락처: ' + escapeHtml(client.phone) : ''}
      </div>`
    });

    naver.maps.Event.addListener(marker, 'click', () => {
      infoWindow.open(map, marker);
    });

    markers.push(marker);
    bounds.extend(position);
    hasPoint = true;
  });

  if (hasPoint) {
    map.fitBounds(bounds);
  }
}

function renderList(filter = '') {
  const list = el('clientList');
  list.innerHTML = '';

  const q = filter.trim().toLowerCase();
  const filtered = clients.filter(c => {
    if (!q) return true;
    return [c.name, c.address, c.manager].join(' ').toLowerCase().includes(q);
  });

  if (filtered.length === 0) {
    list.innerHTML = '<li class="empty-state">등록된 거래처가 없습니다.</li>';
    return;
  }

  filtered.forEach(client => {
    const li = document.createElement('li');
    li.className = 'client-item';
    li.innerHTML = `
      <div class="client-info">
        <div class="name">${escapeHtml(client.name)}</div>
        <div class="addr">${escapeHtml(client.address)}</div>
        <div class="meta">${client.manager ? '담당자: ' + escapeHtml(client.manager) : ''} ${client.phone ? ' · ' + escapeHtml(client.phone) : ''}</div>
      </div>
      <button class="btn go-btn" type="button">보기</button>
    `;

    li.querySelector('.go-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      focusClient(client);
    });

    li.addEventListener('click', () => openEditModal(client));

    list.appendChild(li);
  });
}

function focusClient(client) {
  if (!window.naver || !map || client.lat == null) return;
  map.setCenter(new naver.maps.LatLng(client.lat, client.lng));
  map.setZoom(15);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function showToast(msg) {
  const toast = el('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 3000);
}

// ---------- 탭 전환 ----------
function switchTab(tab) {
  activeTab = tab;
  el('tabClients').classList.toggle('active', tab === 'clients');
  el('tabSchedule').classList.toggle('active', tab === 'schedule');
  el('tabCalendar').classList.toggle('active', tab === 'calendar');
  el('clientsView').classList.toggle('hidden', tab !== 'clients');
  el('scheduleView').classList.toggle('hidden', tab !== 'schedule');
  el('calendarView').classList.toggle('hidden', tab !== 'calendar');

  // 달력 탭은 지도 없이 목록만 보여줍니다.
  el('layout').classList.toggle('no-map', tab === 'calendar');

  if (tab === 'clients') {
    renderMarkers();
  } else if (tab === 'schedule') {
    el('scheduleDate').value = scheduleDate;
    loadSchedule(scheduleDate);
  } else if (tab === 'calendar') {
    loadCalendarMonth(calendarMonth);
    selectCalendarDate(calendarSelectedDate);
  }
}

// ---------- 배차 일정 (오늘의 배차 탭) ----------
async function loadSchedule(date) {
  try {
    const data = await fetchJSON(`/api/schedule?date=${encodeURIComponent(date)}&vehicle=${encodeURIComponent(selectedVehicle)}`);
    scheduleItems = data.items;
    scheduleStartedAt = data.startedAt;
    renderScheduleList();
    renderScheduleMap();
  } catch (err) {
    showToast(err.message);
  }
}

// 두 좌표 사이의 직선거리(km) - 하버사인 공식
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatTime(isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// 각 항목의 (예상/실제) 도착시각과, 다음 항목까지의 대략적인 거리·이동시간을 계산합니다.
// 완료 체크가 된 곳은 실제 완료 시각을 기준으로, 아직 안 간 곳은 이전 지점으로부터의 직선거리 +
// 평균 속도(약 30km/h)로 추정한 이동시간을 누적해서 계산합니다. (실시간 교통정보 반영 X, 대략적인 값)
// 같은 거래처(예: 회사)가 여러 번 나와도 각 항목을 그대로 순서대로 계산하므로 왕복 경로도 정상 동작합니다.
function computeScheduleTimes(items, startedAt) {
  const etas = [];
  const segments = []; // segments[i] = i번째와 i+1번째 항목 사이 구간 정보

  let runningTime = startedAt ? new Date(startedAt) : null;

  items.forEach((item, idx) => {
    const completedAt = item.completedAt || null;
    let eta = null;

    if (completedAt) {
      eta = new Date(completedAt);
      runningTime = new Date(completedAt);
    } else if (runningTime) {
      eta = new Date(runningTime);
    }

    etas.push({ time: eta, completed: !!completedAt });

    if (idx < items.length - 1) {
      const next = items[idx + 1];
      if (item.lat != null && item.lng != null && next.lat != null && next.lng != null) {
        const km = haversineKm(item.lat, item.lng, next.lat, next.lng);
        const min = Math.max(1, Math.round((km / AVG_SPEED_KMH) * 60));
        segments.push({ km, min });
        if (runningTime) runningTime = new Date(runningTime.getTime() + min * 60000);
      } else {
        segments.push(null);
      }
    }
  });

  return { etas, segments };
}

// 같은 거래처를 하루에 여러 번 추가할 수 있으므로(예: 회사 왕복), 이미 추가된 곳도 목록에서 빠지지 않습니다.
function populateScheduleAddSelect() {
  const select = el('scheduleAddSelect');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">거래처 선택해서 추가...</option>';
  clients.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${c.name} (${c.address})`;
    select.appendChild(opt);
  });
  select.value = current || '';
}

function renderScheduleList() {
  const isAdmin = currentRole === 'admin';
  const list = el('scheduleList');
  list.innerHTML = '';

  // 시작 버튼/시작 안내 문구 표시
  el('scheduleStartBox').classList.toggle('hidden', !!scheduleStartedAt || scheduleItems.length === 0);
  const startedInfo = el('scheduleStartedInfo');
  if (scheduleStartedAt) {
    startedInfo.textContent = `🚚 ${formatTime(scheduleStartedAt)}에 배차를 시작했습니다`;
    startedInfo.classList.remove('hidden');
  } else {
    startedInfo.classList.add('hidden');
  }

  if (scheduleItems.length === 0) {
    list.innerHTML = `<li class="empty-state">${scheduleDate} · ${selectedVehicle}에 등록된 배차가 없습니다.${isAdmin ? ' 위에서 거래처를 선택해 추가해주세요.' : ''}</li>`;
    populateScheduleAddSelect();
    return;
  }

  const { etas, segments } = computeScheduleTimes(scheduleItems, scheduleStartedAt);

  scheduleItems.forEach((item, index) => {
    const li = document.createElement('li');
    const eta = etas[index];
    const isDone = eta.completed;
    li.className = 'schedule-item' + (isDone ? ' done' : '');

    let etaHtml = '';
    if (isDone) {
      etaHtml = `<div class="eta completed-time">✅ 완료 ${formatTime(eta.time)}</div>`;
    } else if (eta.time) {
      etaHtml = `<div class="eta">예상 도착 약 ${formatTime(eta.time)}</div>`;
    }

    li.innerHTML = `
      <div class="schedule-order-badge${isDone ? ' done' : ''}">${isDone ? '✓' : index + 1}</div>
      <div class="schedule-item-info">
        <div class="name">${escapeHtml(item.name)}</div>
        <div class="addr">${escapeHtml(item.address)}</div>
        ${etaHtml}
      </div>
    `;

    const actions = document.createElement('div');
    actions.className = 'schedule-item-actions';

    const completeBtn = document.createElement('button');
    completeBtn.type = 'button';
    completeBtn.className = 'complete-btn' + (isDone ? ' done' : '');
    completeBtn.textContent = isDone ? '완료 취소' : '완료';
    if (item.itemId) {
      completeBtn.addEventListener('click', () => toggleScheduleComplete(item.itemId, !isDone));
    } else {
      completeBtn.disabled = true; // 방금 추가되어 아직 저장 중인 항목
    }
    actions.appendChild(completeBtn);

    if (isAdmin) {
      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.textContent = '↑';
      upBtn.disabled = index === 0;
      upBtn.addEventListener('click', () => moveScheduleItem(index, -1));

      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.textContent = '↓';
      downBtn.disabled = index === scheduleItems.length - 1;
      downBtn.addEventListener('click', () => moveScheduleItem(index, 1));

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'remove-btn';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => removeScheduleItem(index));

      actions.appendChild(upBtn);
      actions.appendChild(downBtn);
      actions.appendChild(removeBtn);
    }

    li.appendChild(actions);

    li.addEventListener('click', (e) => {
      if (e.target.closest('button')) return; // 버튼 클릭은 지도 이동과 분리
      focusClient(item);
    });
    li.style.cursor = 'pointer';

    list.appendChild(li);

    // 다음 항목까지 대략적인 거리/시간 안내 (마지막 항목 뒤에는 표시 안 함)
    const segment = segments[index];
    if (segment) {
      const segLi = document.createElement('li');
      segLi.className = 'schedule-segment';
      segLi.textContent = `🚗 다음 항목까지 약 ${segment.km.toFixed(1)}km · 약 ${segment.min}분`;
      list.appendChild(segLi);
    }
  });

  populateScheduleAddSelect();
}

async function toggleScheduleComplete(itemId, done) {
  try {
    await fetchJSON('/api/schedule/complete', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, done })
    });
    await loadSchedule(scheduleDate);
    if (done) showToast('납품 완료로 체크했습니다.');
  } catch (err) {
    showToast(err.message);
  }
}

function moveScheduleItem(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= scheduleItems.length) return;
  const arr = scheduleItems;
  [arr[index], arr[target]] = [arr[target], arr[index]];
  renderScheduleList();
  renderScheduleMap();
  saveScheduleOrder();
}

function removeScheduleItem(index) {
  scheduleItems.splice(index, 1);
  renderScheduleList();
  renderScheduleMap();
  saveScheduleOrder();
}

// 순서 변경/추가/삭제 시 자동으로 저장합니다 (별도의 "저장" 버튼이 필요 없습니다).
async function saveScheduleOrder() {
  try {
    const data = await fetchJSON(`/api/schedule?date=${encodeURIComponent(scheduleDate)}&vehicle=${encodeURIComponent(selectedVehicle)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: scheduleItems.map(it => ({ itemId: it.itemId, clientId: it.id, note: it.note || '' })) })
    });
    scheduleItems = data.items;
    scheduleStartedAt = data.startedAt;
    renderScheduleList();
    renderScheduleMap();
  } catch (err) {
    showToast(err.message);
  }
}

function clearScheduleMap() {
  scheduleMarkers.forEach(m => m.setMap(null));
  scheduleMarkers = [];
  if (schedulePolyline) {
    schedulePolyline.setMap(null);
    schedulePolyline = null;
  }
}

function renderScheduleMap() {
  if (!window.naver || !map) return;
  clearMarkers();
  clearScheduleMap();

  const pts = scheduleItems.filter(it => it.lat != null && it.lng != null);
  if (pts.length === 0) return;

  const bounds = new naver.maps.LatLngBounds();
  const path = [];

  pts.forEach((item, index) => {
    const position = new naver.maps.LatLng(item.lat, item.lng);
    path.push(position);
    bounds.extend(position);

    const marker = new naver.maps.Marker({
      position,
      map,
      title: item.name,
      icon: {
        content: `<div style="background:#1f6feb;color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.35);">${index + 1}</div>`,
        anchor: new naver.maps.Point(14, 14)
      }
    });

    const infoWindow = new naver.maps.InfoWindow({
      content: `<div style="padding:10px 12px; font-size:13px; line-height:1.5;">
        <strong>${index + 1}. ${escapeHtml(item.name)}</strong><br/>
        ${escapeHtml(item.address)}<br/>
        ${item.manager ? '담당자: ' + escapeHtml(item.manager) + '<br/>' : ''}
        ${item.phone ? '연락처: ' + escapeHtml(item.phone) : ''}
      </div>`
    });

    naver.maps.Event.addListener(marker, 'click', () => {
      infoWindow.open(map, marker);
    });

    scheduleMarkers.push(marker);
  });

  if (path.length > 1) {
    schedulePolyline = new naver.maps.Polyline({
      map,
      path,
      strokeColor: '#1f6feb',
      strokeWeight: 3,
      strokeOpacity: 0.7
    });
  }

  map.fitBounds(bounds);
}

function dateStringFrom(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------- 달력 탭 (지도 없이 날짜별 배차 목록) ----------
function shiftMonth(monthStr, delta) {
  const [y, m] = monthStr.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function loadCalendarMonth(month) {
  try {
    const data = await fetchJSON(`/api/schedule/month?month=${encodeURIComponent(month)}&vehicle=${encodeURIComponent(selectedVehicle)}`);
    calendarCounts = data.counts || {};
  } catch (err) {
    calendarCounts = {};
    showToast(err.message);
  }
  renderCalendarGrid();
}

// 달력을 일~토 7칸씩 주(週) 단위로 나눕니다. (앞뒤 빈 칸은 null)
function buildMonthWeeks(year, month) {
  const firstDay = new Date(year, month - 1, 1);
  const startWeekday = firstDay.getDay();
  const daysInMonth = new Date(year, month, 0).getDate();

  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

// 달력 그리드: 선택한 날짜가 속한 주(週)만 그 자리에서 바로 아래로 펼쳐져 배차 내용을 보여주고,
// 다른 주를 선택하면 그 주는 접히고 새로 선택한 주가 펼쳐집니다.
function renderCalendarGrid() {
  const grid = el('calGrid');
  grid.innerHTML = '';

  const [year, month] = calendarMonth.split('-').map(Number);
  el('calMonthLabel').textContent = `${year}년 ${month}월`;

  const dowRow = document.createElement('div');
  dowRow.className = 'cal-dow-row';
  ['일', '월', '화', '수', '목', '금', '토'].forEach(name => {
    const dow = document.createElement('div');
    dow.className = 'cal-dow';
    dow.textContent = name;
    dowRow.appendChild(dow);
  });
  grid.appendChild(dowRow);

  const weeks = buildMonthWeeks(year, month);
  const today = todayDateString();

  weeks.forEach(week => {
    const weekRow = document.createElement('div');
    weekRow.className = 'cal-week-row';

    week.forEach(dateStr => {
      const cell = document.createElement('div');
      cell.className = 'cal-cell' + (!dateStr ? ' empty' : '');

      if (dateStr) {
        if (dateStr === today) cell.classList.add('today');
        if (dateStr === calendarSelectedDate) cell.classList.add('selected');

        const count = calendarCounts[dateStr] || 0;
        cell.innerHTML = `
          <div class="cal-date-num">${Number(dateStr.split('-')[2])}</div>
          ${count > 0 ? `<div class="cal-count-badge">${count}건</div>` : ''}
        `;
        cell.addEventListener('click', () => selectCalendarDate(dateStr));
      }

      weekRow.appendChild(cell);
    });

    grid.appendChild(weekRow);

    // 선택한 날짜가 이 주(週)에 있으면, 이 행 바로 아래에 그 주의 배차 내용을 펼쳐서 보여줍니다.
    if (week.includes(calendarSelectedDate)) {
      grid.appendChild(buildWeekStripNode());
    }
  });
}

// 특정 날짜가 속한 주(일요일~토요일) 7개 날짜를 구합니다.
function getWeekDates(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay();
  const sunday = new Date(d);
  sunday.setDate(d.getDate() - dow);
  const result = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(sunday);
    day.setDate(sunday.getDate() + i);
    result.push(dateStringFrom(day));
  }
  return result;
}

async function fetchDaySchedule(date) {
  try {
    const data = await fetchJSON(`/api/schedule?date=${encodeURIComponent(date)}&vehicle=${encodeURIComponent(selectedVehicle)}`);
    return { items: data.items };
  } catch (err) {
    return { items: [] };
  }
}

async function selectCalendarDate(dateStr) {
  calendarSelectedDate = dateStr;
  calendarWeekDates = getWeekDates(dateStr);
  renderCalendarGrid();
  await loadCalendarWeek();
}

async function loadCalendarWeek() {
  const results = await Promise.all(calendarWeekDates.map(fetchDaySchedule));
  calendarWeekData = new Map(calendarWeekDates.map((d, i) => [d, results[i]]));
  renderCalendarGrid();
}

// 선택한 날짜가 속한 주(일~토)를 한 줄에 나란히 보여주는 영역을 만듭니다.
// 실제 납품을 가지 않는 토/일요일은 좁게, 월~금은 넓게 표시합니다.
// 같은 날짜 안에서 순서를 바꾸는 것은 물론, 다른 날짜의 칸으로 드래그해서 옮기는 것도 가능합니다.
function buildWeekStripNode() {
  const strip = document.createElement('div');
  strip.className = 'cal-week-strip';

  const isAdmin = currentRole === 'admin';
  const today = todayDateString();
  const dowNames = ['일', '월', '화', '수', '목', '금', '토'];

  calendarWeekDates.forEach((dateStr, dowIndex) => {
    const isWeekend = dowIndex === 0 || dowIndex === 6;
    const dayData = calendarWeekData.get(dateStr) || { items: [] };
    const dayNum = Number(dateStr.split('-')[2]);

    const col = document.createElement('div');
    col.className = 'cal-day-col'
      + (isWeekend ? ' weekend' : '')
      + (dateStr === today ? ' today' : '')
      + (dateStr === calendarSelectedDate ? ' selected-day' : '');

    const header = document.createElement('div');
    header.className = 'cal-day-col-header';
    header.innerHTML = `<span class="cal-day-dow">${dowNames[dowIndex]}</span><span class="cal-day-num">${dayNum}</span>`;
    col.appendChild(header);

    const listEl = document.createElement('ul');
    listEl.className = 'cal-day-list';

    if (dayData.items.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'cal-day-empty';
      empty.textContent = '-';
      listEl.appendChild(empty);
    } else {
      dayData.items.forEach((item, index) => {
        const isDone = !!item.completedAt;
        const note = item.note || '';

        const li = document.createElement('li');
        li.className = 'cal-day-item' + (isDone ? ' done' : '');
        li.dataset.index = String(index);
        li.title = `${item.name} · ${item.address}`;

        li.innerHTML = `
          <div class="cal-day-item-top">
            <span class="cal-day-item-badge${isDone ? ' done' : ''}">${isDone ? '✓' : index + 1}</span>
            <span class="cal-day-item-name">${escapeHtml(item.name)}</span>
          </div>
        `;

        if (isAdmin) {
          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'cal-day-remove-btn';
          removeBtn.textContent = '×';
          removeBtn.addEventListener('click', () => removeDayItem(dateStr, index));
          li.appendChild(removeBtn);

          const noteInput = document.createElement('input');
          noteInput.type = 'text';
          noteInput.className = 'cal-day-note-input';
          noteInput.placeholder = '수량';
          noteInput.value = note;
          noteInput.maxLength = 200;
          if (item.itemId) {
            noteInput.addEventListener('blur', () => saveDayNote(dateStr, item.itemId, noteInput.value));
          } else {
            noteInput.disabled = true; // 방금 추가/이동되어 아직 저장 중인 항목
          }
          li.appendChild(noteInput);

          // 드래그로 순서를 바꾸거나(같은 날짜), 다른 날짜 칸으로 옮길 수 있습니다.
          li.draggable = true;
          li.addEventListener('dragstart', (e) => {
            calDragIndex = index;
            calDragDate = dateStr;
            e.dataTransfer.effectAllowed = 'move';
            li.classList.add('dragging');
          });
          li.addEventListener('dragend', () => {
            li.classList.remove('dragging');
            document.querySelectorAll('.cal-day-item').forEach(el2 => el2.classList.remove('drag-over'));
          });
          li.addEventListener('dragover', (e) => {
            e.preventDefault();
            li.classList.add('drag-over');
          });
          li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
          li.addEventListener('drop', (e) => {
            e.preventDefault();
            li.classList.remove('drag-over');
            moveDraggedItem(dateStr, Number(li.dataset.index));
          });
        } else if (note) {
          const noteText = document.createElement('div');
          noteText.className = 'cal-day-note-text';
          noteText.textContent = `📦${note}`;
          li.appendChild(noteText);
        }

        listEl.appendChild(li);
      });
    }

    // 목록의 빈 공간(항목이 없는 날, 또는 맨 끝)에 놓아도 추가/이동되도록 목록 자체도 드롭 대상으로 둡니다.
    if (isAdmin) {
      listEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        listEl.classList.add('drag-over-list');
      });
      listEl.addEventListener('dragleave', () => listEl.classList.remove('drag-over-list'));
      listEl.addEventListener('drop', (e) => {
        e.preventDefault();
        listEl.classList.remove('drag-over-list');
        moveDraggedItem(dateStr, dayData.items.length);
      });
    }

    col.appendChild(listEl);

    if (isAdmin) {
      const addWrap = document.createElement('div');
      addWrap.className = 'cal-day-add';
      const select = document.createElement('select');
      select.className = 'cal-day-add-select';

      const defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = '+ 추가';
      select.appendChild(defaultOpt);

      // 같은 거래처(예: 회사)를 하루에 여러 번 추가할 수 있도록 이미 추가된 곳도 목록에 계속 보여줍니다.
      clients.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        select.appendChild(opt);
      });

      select.addEventListener('change', () => {
        const id = select.value;
        if (!id) return;
        addDayItem(dateStr, id);
      });

      addWrap.appendChild(select);
      col.appendChild(addWrap);
    }

    strip.appendChild(col);
  });

  return strip;
}

// 드래그했던 항목을 targetDate의 targetIndex 위치로 옮깁니다.
// 같은 날짜 안에서는 순서만 바뀌고, 다른 날짜로 옮기면 완료 상태는 초기화되고(그 날짜엔 아직
// 안 간 것이므로) 메모는 그대로 유지된 채 새 항목으로 등록됩니다.
function moveDraggedItem(targetDate, targetIndex) {
  const sourceDate = calDragDate;
  const sourceIndex = calDragIndex;
  calDragDate = null;
  calDragIndex = null;
  if (sourceDate == null || sourceIndex == null) return;

  const sourceDayData = calendarWeekData.get(sourceDate);
  const targetDayData = calendarWeekData.get(targetDate);
  if (!sourceDayData || !targetDayData) return;

  if (sourceDate === targetDate) {
    if (sourceIndex === targetIndex) return;
    const [moved] = sourceDayData.items.splice(sourceIndex, 1);
    sourceDayData.items.splice(targetIndex, 0, moved);
    renderCalendarGrid();
    saveDayOrder(sourceDate);
  } else {
    const [moved] = sourceDayData.items.splice(sourceIndex, 1);
    targetDayData.items.splice(targetIndex, 0, { ...moved, itemId: null, completedAt: null });
    renderCalendarGrid();
    saveDayOrder(sourceDate);
    saveDayOrder(targetDate);
  }
}

async function saveDayOrder(date) {
  const dayData = calendarWeekData.get(date);
  if (!dayData) return;
  try {
    const res = await fetchJSON(`/api/schedule?date=${encodeURIComponent(date)}&vehicle=${encodeURIComponent(selectedVehicle)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: dayData.items.map(it => ({ itemId: it.itemId, clientId: it.id, note: it.note || '' })) })
    });
    dayData.items = res.items; // 실제 itemId/순서를 서버 응답으로 다시 채움
    renderCalendarGrid();
    await loadCalendarMonth(calendarMonth);
  } catch (err) {
    showToast(err.message);
  }
}

async function removeDayItem(date, index) {
  const dayData = calendarWeekData.get(date);
  if (!dayData) return;
  dayData.items.splice(index, 1);
  renderCalendarGrid();
  await saveDayOrder(date);
  showToast('배차 목록에서 제외했습니다.');
}

async function addDayItem(date, clientId) {
  const dayData = calendarWeekData.get(date);
  if (!dayData) return;
  const clientData = clients.find(c => c.id === clientId);
  if (!clientData) return;
  dayData.items.push({ itemId: null, ...clientData, completedAt: null, note: '' });
  renderCalendarGrid();
  await saveDayOrder(date);
  showToast('배차 목록에 추가했습니다.');
}

async function saveDayNote(date, itemId, note) {
  const dayData = calendarWeekData.get(date);
  if (!dayData || !itemId) return;
  const item = dayData.items.find(it => it.itemId === itemId);
  const trimmed = note.trim();
  if (item && (item.note || '') === trimmed) return;
  try {
    await fetchJSON('/api/schedule/note', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, note: trimmed })
    });
    if (item) item.note = trimmed;
    showToast('메모를 저장했습니다.');
  } catch (err) {
    showToast(err.message);
  }
}

// ---------- 모달 ----------
const FORM_FIELD_IDS = ['fName', 'fAddress', 'fManager', 'fPhone', 'fMemo'];

function setFormReadOnly(readOnly) {
  FORM_FIELD_IDS.forEach(id => { el(id).disabled = readOnly; });
  el('deleteBtn').classList.toggle('hidden', readOnly);
  el('saveBtn').classList.toggle('hidden', readOnly);
}

function openAddModal() {
  if (currentRole !== 'admin') return; // 방어적 체크 (버튼은 이미 숨겨져 있음)
  editingId = null;
  el('modalTitle').textContent = '신규 거래처 추가';
  el('clientForm').reset();
  el('clientId').value = '';
  setFormReadOnly(false);
  el('deleteBtn').classList.add('hidden');
  el('formError').classList.add('hidden');
  el('modalOverlay').classList.remove('hidden');
}

function openEditModal(client) {
  const isAdmin = currentRole === 'admin';
  editingId = client.id;
  el('modalTitle').textContent = isAdmin ? '거래처 수정' : '거래처 정보';
  el('clientId').value = client.id;
  el('fName').value = client.name;
  el('fAddress').value = client.address;
  el('fManager').value = client.manager || '';
  el('fPhone').value = client.phone || '';
  el('fMemo').value = client.memo || '';
  setFormReadOnly(!isAdmin);
  el('formError').classList.add('hidden');
  el('modalOverlay').classList.remove('hidden');
}

function closeModal() {
  el('modalOverlay').classList.add('hidden');
}

function bindEvents() {
  el('addBtn').addEventListener('click', openAddModal);
  el('cancelBtn').addEventListener('click', closeModal);

  el('logoutBtn').addEventListener('click', async () => {
    if (!confirm('로그아웃할까요?')) return;
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
  });
  el('modalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'modalOverlay') closeModal();
  });

  el('searchInput').addEventListener('input', (e) => renderList(e.target.value));

  el('clientForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitter = e.submitter;
    const errorBox = el('formError');
    errorBox.classList.add('hidden');

    const payload = {
      name: el('fName').value.trim(),
      address: el('fAddress').value.trim(),
      manager: el('fManager').value.trim(),
      phone: el('fPhone').value.trim(),
      memo: el('fMemo').value.trim()
    };

    try {
      if (submitter && submitter.id === 'deleteBtn') {
        if (!confirm('이 거래처를 삭제할까요?')) return;
        await fetchJSON(`/api/clients/${editingId}`, { method: 'DELETE' });
        showToast('거래처를 삭제했습니다.');
      } else if (editingId) {
        await fetchJSON(`/api/clients/${editingId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        showToast('거래처 정보를 수정했습니다.');
      } else {
        await fetchJSON('/api/clients', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        showToast('신규 거래처를 추가했습니다.');
      }

      closeModal();
      await refreshClients();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.classList.remove('hidden');
    }
  });

  // ---------- 탭 이벤트 ----------
  el('tabClients').addEventListener('click', () => switchTab('clients'));
  el('tabSchedule').addEventListener('click', () => switchTab('schedule'));
  el('tabCalendar').addEventListener('click', () => switchTab('calendar'));

  // ---------- 차량 선택 이벤트 (오늘의 배차/달력 탭 공통) ----------
  document.querySelectorAll('.vehicle-btn').forEach(btn => {
    btn.addEventListener('click', () => setSelectedVehicle(btn.dataset.vehicle));
  });

  // ---------- 배차 일정 이벤트 ----------
  el('scheduleStartBtn').addEventListener('click', async () => {
    try {
      await fetchJSON(`/api/schedule/start?date=${encodeURIComponent(scheduleDate)}&vehicle=${encodeURIComponent(selectedVehicle)}`, { method: 'PATCH' });
      showToast('오늘의 배차를 시작했습니다.');
      await loadSchedule(scheduleDate);
    } catch (err) {
      showToast(err.message);
    }
  });

  el('scheduleDate').addEventListener('change', (e) => {
    scheduleDate = e.target.value || todayDateString();
    loadSchedule(scheduleDate);
  });

  el('schedulePrevDay').addEventListener('click', () => {
    const d = new Date(scheduleDate + 'T00:00:00');
    d.setDate(d.getDate() - 1);
    scheduleDate = dateStringFrom(d);
    el('scheduleDate').value = scheduleDate;
    loadSchedule(scheduleDate);
  });

  el('scheduleNextDay').addEventListener('click', () => {
    const d = new Date(scheduleDate + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    scheduleDate = dateStringFrom(d);
    el('scheduleDate').value = scheduleDate;
    loadSchedule(scheduleDate);
  });

  el('scheduleAddBtn').addEventListener('click', () => {
    const select = el('scheduleAddSelect');
    const id = select.value;
    if (!id) return;
    const clientData = clients.find(c => c.id === id);
    if (!clientData) return;
    scheduleItems.push({ itemId: null, ...clientData, completedAt: null, note: '' });
    select.value = '';
    renderScheduleList();
    renderScheduleMap();
    saveScheduleOrder();
  });

  // ---------- 달력 탭 이벤트 ----------
  el('calPrevMonth').addEventListener('click', () => {
    calendarMonth = shiftMonth(calendarMonth, -1);
    loadCalendarMonth(calendarMonth);
  });

  el('calNextMonth').addEventListener('click', () => {
    calendarMonth = shiftMonth(calendarMonth, 1);
    loadCalendarMonth(calendarMonth);
  });
}

init();
