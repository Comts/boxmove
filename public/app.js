let map = null;
let markers = [];
let clients = [];
let editingId = null;
let currentRole = null; // 'admin' | 'viewer'
let activeTab = 'clients'; // 'clients' | 'schedule'

// 배차 일정 상태
let scheduleDate = todayDateString();
let scheduleClientIds = []; // 현재 화면에 표시 중인(아직 저장 안 됐을 수도 있는) 순서
let scheduleStartedAt = null; // 오늘 배차를 시작한 시각 (ISO 문자열, 시작 전이면 null)
let scheduleMarkers = [];
let schedulePolyline = null;

// 다음 거래처까지 예상 이동시간 계산에 사용하는 평균 주행 속도(도심/근거리 배송 기준 대략적인 값)
const AVG_SPEED_KMH = 30;

// 달력 탭 상태 (지도 없이 날짜별 배차 목록만 보는 화면)
let calendarMonth = todayDateString().slice(0, 7); // 'YYYY-MM'
let calendarSelectedDate = todayDateString();
let calendarWeekDates = []; // 선택한 날짜가 속한 주(일~토) 7개 날짜
let calendarWeekData = new Map(); // date -> { clientIds, completedMap, noteMap }
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

  // 기사님 계정은 로그인하면 바로 오늘의 배차 화면부터 보여줍니다.
  switchTab(currentRole === 'viewer' ? 'schedule' : 'clients');
}

function applyRoleUI() {
  const isAdmin = currentRole === 'admin';
  el('addBtn').classList.toggle('hidden', !isAdmin);
  el('scheduleAddBox').classList.toggle('hidden', !isAdmin);
  el('scheduleAdminActions').classList.toggle('hidden', !isAdmin);

  const badge = el('roleBadge');
  if (badge) {
    badge.textContent = isAdmin ? '관리자' : '조회 전용';
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

// ---------- 배차 일정 ----------
let scheduleCompletedMap = new Map(); // clientId -> 완료 시각(ISO) | null

async function loadSchedule(date) {
  try {
    const data = await fetchJSON(`/api/schedule?date=${encodeURIComponent(date)}`);
    scheduleClientIds = data.clientIds;
    scheduleStartedAt = data.startedAt;
    scheduleCompletedMap = new Map(data.clients.map(c => [c.id, c.completedAt]));
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

// 각 거래처의 (예상/실제) 도착시각과, 다음 거래처까지의 대략적인 거리·이동시간을 계산합니다.
// 완료 체크가 된 곳은 실제 완료 시각을 기준으로, 아직 안 간 곳은 이전 지점으로부터의 직선거리 +
// 평균 속도(약 30km/h)로 추정한 이동시간을 누적해서 계산합니다. (실시간 교통정보 반영 X, 대략적인 값)
function computeScheduleTimes(scheduleClients, startedAt) {
  const etas = [];
  const segments = []; // segments[i] = i번째와 i+1번째 거래처 사이 구간 정보

  let runningTime = startedAt ? new Date(startedAt) : null;

  scheduleClients.forEach((client, idx) => {
    const completedAt = scheduleCompletedMap.get(client.id) || null;
    let eta = null;

    if (completedAt) {
      eta = new Date(completedAt);
      runningTime = new Date(completedAt);
    } else if (runningTime) {
      eta = new Date(runningTime);
    }

    etas.push({ time: eta, completed: !!completedAt });

    if (idx < scheduleClients.length - 1) {
      const next = scheduleClients[idx + 1];
      if (client.lat != null && client.lng != null && next.lat != null && next.lng != null) {
        const km = haversineKm(client.lat, client.lng, next.lat, next.lng);
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

function populateScheduleAddSelect() {
  const select = el('scheduleAddSelect');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">거래처 선택해서 추가...</option>';
  clients
    .filter(c => !scheduleClientIds.includes(c.id))
    .forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.name} (${c.address})`;
      select.appendChild(opt);
    });
  select.value = current && !scheduleClientIds.includes(current) ? current : '';
}

function renderScheduleList() {
  const isAdmin = currentRole === 'admin';
  const list = el('scheduleList');
  list.innerHTML = '';

  const scheduleClients = scheduleClientIds
    .map(id => clients.find(c => c.id === id))
    .filter(Boolean);

  // 시작 버튼/시작 안내 문구 표시
  el('scheduleStartBox').classList.toggle('hidden', !!scheduleStartedAt || scheduleClients.length === 0);
  const startedInfo = el('scheduleStartedInfo');
  if (scheduleStartedAt) {
    startedInfo.textContent = `🚚 ${formatTime(scheduleStartedAt)}에 배차를 시작했습니다`;
    startedInfo.classList.remove('hidden');
  } else {
    startedInfo.classList.add('hidden');
  }

  if (scheduleClients.length === 0) {
    list.innerHTML = `<li class="empty-state">${scheduleDate}에 등록된 배차가 없습니다.${isAdmin ? ' 위에서 거래처를 선택해 추가해주세요.' : ''}</li>`;
    populateScheduleAddSelect();
    return;
  }

  const { etas, segments } = computeScheduleTimes(scheduleClients, scheduleStartedAt);

  scheduleClients.forEach((client, index) => {
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
        <div class="name">${escapeHtml(client.name)}</div>
        <div class="addr">${escapeHtml(client.address)}</div>
        ${etaHtml}
      </div>
    `;

    const actions = document.createElement('div');
    actions.className = 'schedule-item-actions';

    const completeBtn = document.createElement('button');
    completeBtn.type = 'button';
    completeBtn.className = 'complete-btn' + (isDone ? ' done' : '');
    completeBtn.textContent = isDone ? '완료 취소' : '완료';
    completeBtn.addEventListener('click', () => toggleScheduleComplete(client.id, !isDone));
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
      downBtn.disabled = index === scheduleClients.length - 1;
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
      focusClient(client);
    });
    li.style.cursor = 'pointer';

    list.appendChild(li);

    // 다음 거래처까지 대략적인 거리/시간 안내 (마지막 항목 뒤에는 표시 안 함)
    const segment = segments[index];
    if (segment) {
      const segLi = document.createElement('li');
      segLi.className = 'schedule-segment';
      segLi.textContent = `🚗 다음 거래처까지 약 ${segment.km.toFixed(1)}km · 약 ${segment.min}분`;
      list.appendChild(segLi);
    }
  });

  populateScheduleAddSelect();
}

async function toggleScheduleComplete(clientId, done) {
  try {
    await fetchJSON(`/api/schedule/complete?date=${encodeURIComponent(scheduleDate)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, done })
    });
    await loadSchedule(scheduleDate);
    if (done) showToast('납품 완료로 체크했습니다.');
  } catch (err) {
    showToast(err.message);
  }
}

function moveScheduleItem(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= scheduleClientIds.length) return;
  const arr = scheduleClientIds;
  [arr[index], arr[target]] = [arr[target], arr[index]];
  renderScheduleList();
  renderScheduleMap();
}

function removeScheduleItem(index) {
  scheduleClientIds.splice(index, 1);
  renderScheduleList();
  renderScheduleMap();
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

  const scheduleClients = scheduleClientIds
    .map(id => clients.find(c => c.id === id))
    .filter(c => c && c.lat != null && c.lng != null);

  if (scheduleClients.length === 0) return;

  const bounds = new naver.maps.LatLngBounds();
  const path = [];

  scheduleClients.forEach((client, index) => {
    const position = new naver.maps.LatLng(client.lat, client.lng);
    path.push(position);
    bounds.extend(position);

    const marker = new naver.maps.Marker({
      position,
      map,
      title: client.name,
      icon: {
        content: `<div style="background:#1f6feb;color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.35);">${index + 1}</div>`,
        anchor: new naver.maps.Point(14, 14)
      }
    });

    const infoWindow = new naver.maps.InfoWindow({
      content: `<div style="padding:10px 12px; font-size:13px; line-height:1.5;">
        <strong>${index + 1}. ${escapeHtml(client.name)}</strong><br/>
        ${escapeHtml(client.address)}<br/>
        ${client.manager ? '담당자: ' + escapeHtml(client.manager) + '<br/>' : ''}
        ${client.phone ? '연락처: ' + escapeHtml(client.phone) : ''}
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

function formatDateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${dow})`;
}

async function loadCalendarMonth(month) {
  try {
    const data = await fetchJSON(`/api/schedule/month?month=${encodeURIComponent(month)}`);
    calendarCounts = data.counts || {};
  } catch (err) {
    calendarCounts = {};
    showToast(err.message);
  }
  renderCalendarGrid();
}

function renderCalendarGrid() {
  const grid = el('calGrid');
  grid.innerHTML = '';

  const [year, month] = calendarMonth.split('-').map(Number);
  el('calMonthLabel').textContent = `${year}년 ${month}월`;

  ['일', '월', '화', '수', '목', '금', '토'].forEach(name => {
    const cell = document.createElement('div');
    cell.className = 'cal-dow';
    cell.textContent = name;
    grid.appendChild(cell);
  });

  const firstDay = new Date(year, month - 1, 1);
  const startWeekday = firstDay.getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const today = todayDateString();

  for (let i = 0; i < startWeekday; i++) {
    const empty = document.createElement('div');
    empty.className = 'cal-cell empty';
    grid.appendChild(empty);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const cell = document.createElement('div');
    cell.className = 'cal-cell';
    if (dateStr === today) cell.classList.add('today');
    if (calendarWeekDates.includes(dateStr)) cell.classList.add('in-week');
    if (dateStr === calendarSelectedDate) cell.classList.add('selected');

    const count = calendarCounts[dateStr] || 0;
    cell.innerHTML = `
      <div class="cal-date-num">${day}</div>
      ${count > 0 ? `<div class="cal-count-badge">${count}건</div>` : ''}
    `;
    cell.addEventListener('click', () => selectCalendarDate(dateStr));
    grid.appendChild(cell);
  }
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
    const data = await fetchJSON(`/api/schedule?date=${encodeURIComponent(date)}`);
    return {
      clientIds: data.clientIds,
      completedMap: new Map(data.clients.map(c => [c.id, c.completedAt])),
      noteMap: new Map(data.clients.map(c => [c.id, c.note || '']))
    };
  } catch (err) {
    return { clientIds: [], completedMap: new Map(), noteMap: new Map() };
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
  renderCalendarWeekStrip();
}

// 선택한 날짜가 속한 주(일~토)를 한 줄에 나란히 보여줍니다.
// 실제 납품을 가지 않는 토/일요일은 좁게, 월~금은 넓게 표시합니다.
function renderCalendarWeekStrip() {
  const strip = el('calWeekStrip');
  strip.innerHTML = '';

  const isAdmin = currentRole === 'admin';
  const today = todayDateString();
  const dowNames = ['일', '월', '화', '수', '목', '금', '토'];

  calendarWeekDates.forEach((dateStr, dowIndex) => {
    const isWeekend = dowIndex === 0 || dowIndex === 6;
    const dayData = calendarWeekData.get(dateStr) || { clientIds: [], completedMap: new Map(), noteMap: new Map() };
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

    const dayClients = dayData.clientIds.map(id => clients.find(c => c.id === id)).filter(Boolean);

    if (dayClients.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'cal-day-empty';
      empty.textContent = '-';
      listEl.appendChild(empty);
    } else {
      dayClients.forEach((client, index) => {
        const completedAt = dayData.completedMap.get(client.id) || null;
        const isDone = !!completedAt;
        const note = dayData.noteMap.get(client.id) || '';

        const li = document.createElement('li');
        li.className = 'cal-day-item' + (isDone ? ' done' : '');
        li.dataset.index = String(index);
        li.title = `${client.name} · ${client.address}`;

        li.innerHTML = `
          <div class="cal-day-item-top">
            <span class="cal-day-item-badge${isDone ? ' done' : ''}">${isDone ? '✓' : index + 1}</span>
            <span class="cal-day-item-name">${escapeHtml(client.name)}</span>
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
          noteInput.addEventListener('blur', () => saveDayNote(dateStr, client.id, noteInput.value));
          li.appendChild(noteInput);

          li.draggable = true;
          li.addEventListener('dragstart', (e) => {
            calDragIndex = index;
            calDragDate = dateStr;
            e.dataTransfer.effectAllowed = 'move';
            li.classList.add('dragging');
          });
          li.addEventListener('dragend', () => {
            li.classList.remove('dragging');
            listEl.querySelectorAll('.cal-day-item').forEach(item => item.classList.remove('drag-over'));
          });
          li.addEventListener('dragover', (e) => {
            if (calDragDate !== dateStr) return; // 같은 날짜 안에서만 순서 변경 가능
            e.preventDefault();
            li.classList.add('drag-over');
          });
          li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
          li.addEventListener('drop', (e) => {
            if (calDragDate !== dateStr) return;
            e.preventDefault();
            li.classList.remove('drag-over');
            const targetIndex = Number(li.dataset.index);
            if (calDragIndex === null || calDragIndex === targetIndex) return;
            const [moved] = dayData.clientIds.splice(calDragIndex, 1);
            dayData.clientIds.splice(targetIndex, 0, moved);
            calDragIndex = null;
            calDragDate = null;
            renderCalendarWeekStrip();
            saveDayOrder(dateStr);
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

      clients
        .filter(c => !dayData.clientIds.includes(c.id))
        .forEach(c => {
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
}

async function saveDayOrder(date) {
  const dayData = calendarWeekData.get(date);
  if (!dayData) return;
  try {
    await fetchJSON(`/api/schedule?date=${encodeURIComponent(date)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientIds: dayData.clientIds })
    });
  } catch (err) {
    showToast(err.message);
  }
}

async function removeDayItem(date, index) {
  const dayData = calendarWeekData.get(date);
  if (!dayData) return;
  dayData.clientIds.splice(index, 1);
  renderCalendarWeekStrip();
  await saveDayOrder(date);
  await loadCalendarMonth(calendarMonth);
  showToast('배차 목록에서 제외했습니다.');
}

async function addDayItem(date, clientId) {
  const dayData = calendarWeekData.get(date);
  if (!dayData) return;
  dayData.clientIds.push(clientId);
  dayData.completedMap.set(clientId, null);
  dayData.noteMap.set(clientId, '');
  renderCalendarWeekStrip();
  await saveDayOrder(date);
  await loadCalendarMonth(calendarMonth);
  showToast('배차 목록에 추가했습니다.');
}

async function saveDayNote(date, clientId, note) {
  const dayData = calendarWeekData.get(date);
  if (!dayData) return;
  const trimmed = note.trim();
  if ((dayData.noteMap.get(clientId) || '') === trimmed) return;
  try {
    await fetchJSON(`/api/schedule/note?date=${encodeURIComponent(date)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, note: trimmed })
    });
    dayData.noteMap.set(clientId, trimmed);
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

  // ---------- 배차 일정 이벤트 ----------
  el('tabClients').addEventListener('click', () => switchTab('clients'));
  el('tabSchedule').addEventListener('click', () => switchTab('schedule'));
  el('tabCalendar').addEventListener('click', () => switchTab('calendar'));

  el('scheduleStartBtn').addEventListener('click', async () => {
    try {
      await fetchJSON(`/api/schedule/start?date=${encodeURIComponent(scheduleDate)}`, { method: 'PATCH' });
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
    scheduleClientIds.push(id);
    select.value = '';
    renderScheduleList();
    renderScheduleMap();
  });

  el('scheduleSaveBtn').addEventListener('click', async () => {
    try {
      await fetchJSON(`/api/schedule?date=${encodeURIComponent(scheduleDate)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientIds: scheduleClientIds })
      });
      showToast('배차 순서를 저장했습니다.');
    } catch (err) {
      showToast(err.message);
    }
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
