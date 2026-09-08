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
  el('clientsView').classList.toggle('hidden', tab !== 'clients');
  el('scheduleView').classList.toggle('hidden', tab !== 'schedule');

  if (tab === 'clients') {
    renderMarkers();
  } else {
    el('scheduleDate').value = scheduleDate;
    loadSchedule(scheduleDate);
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
}

init();
