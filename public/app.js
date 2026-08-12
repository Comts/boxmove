let map = null;
let markers = [];
let clients = [];
let editingId = null;
let currentRole = null; // 'admin' | 'viewer'

const el = id => document.getElementById(id);

async function init() {
  const me = await fetchJSON('/api/me');
  currentRole = me.role;
  applyRoleUI();

  const config = await fetchJSON('/api/config');
  await loadNaverMapsScript(config.naverMapsClientId);
  initMap();
  await refreshClients();
  bindEvents();
}

function applyRoleUI() {
  const isAdmin = currentRole === 'admin';
  el('addBtn').classList.toggle('hidden', !isAdmin);

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
    script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpClientId=${clientId}`;
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
  renderMarkers();
  renderList();
}

function clearMarkers() {
  markers.forEach(m => m.setMap(null));
  markers = [];
}

function renderMarkers() {
  if (!window.naver || !map) return;
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
  const position = new naver.maps.LatLng(client.lat, client.lng);
  map.setCenter(position);
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
}

init();
