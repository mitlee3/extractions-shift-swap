const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
let users = [];
let selectedUserId = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text == null ? '' : String(text);
  return node;
}
function displayDate(value) {
  if (!value) return 'Date unavailable';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  const date = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function showMessage(node, text) { node.textContent = text; node.hidden = !text; }

function renderUsers() {
  const list = document.querySelector('#users-list');
  list.replaceChildren();
  for (const user of users) {
    const button = element('button', `user-row${user.id === selectedUserId ? ' selected' : ''}`);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(user.id === selectedUserId));
    const name = element('strong', '', user.name || 'Unnamed user');
    const email = element('span', '', user.email);
    button.append(name, email);
    if (user.profileComplete) button.append(element('small', '', `Shift ${user.shiftNumber} · ${user.position}`));
    else button.append(element('small', '', 'Profile incomplete'));
    button.addEventListener('click', () => loadUser(user.id));
    list.append(button);
  }
  showMessage(document.querySelector('#users-message'), users.length ? '' : 'No users found.');
}

function renderSchedules(schedules) {
  const container = document.querySelector('#schedule-history');
  container.replaceChildren();
  if (!schedules.length) { container.append(element('p', 'empty-list', 'No schedule history is available.')); return; }
  schedules.forEach((schedule, index) => {
    const card = element('article', `schedule-entry${index === 0 ? ' current' : ''}`);
    card.append(element('h4', '', index === 0 ? 'Most recent schedule' : `Schedule change ${schedules.length - index}`));
    card.append(element('p', '', `Shift ${schedule.shift_number} · ${schedule.position}`));
    card.append(element('p', '', `Updated ${displayDate(schedule.created_at)}`));
    const days = element('div', 'schedule-days');
    (schedule.shift_days || []).map(Number).forEach((day) => days.append(element('span', 'schedule-day', dayNames[day] || '')));
    card.append(days);
    container.append(card);
  });
}

function renderSwapGroup(panelId, rows, type) {
  const panel = document.querySelector(`#${panelId}`);
  panel.replaceChildren();
  if (!rows.length) { panel.append(element('p', 'empty-list', 'No shift swaps in this category.')); return; }
  rows.forEach((swap) => {
    const card = element('article', 'swap-card');
    const details = document.createElement('div');
    const title = type === 'open' ? 'Open request' : `${swap.requester_name} ↔ ${swap.offering_name}`;
    details.append(element('h4', '', title));
    const dates = type === 'open'
      ? `Requested day off: ${displayDate(swap.requester_date)}`
      : `Requested: ${displayDate(swap.requester_date)} · Offered: ${displayDate(swap.offering_date)}`;
    details.append(element('p', '', `${dates} · Submitted ${displayDate(swap.submitted_at)}`));
    const status = type === 'open' ? 'Open' : swap.status;
    const normalized = String(status).toLowerCase();
    const statusClass = normalized.includes('accepted') ? 'accepted' : normalized.includes('pending') ? 'pending' : (type === 'open' ? 'open' : 'closed');
    card.append(details, element('span', `swap-status ${statusClass}`, status));
    panel.append(card);
  });
}

async function loadUser(id) {
  selectedUserId = id;
  renderUsers();
  document.querySelector('#empty-detail').hidden = true;
  document.querySelector('#detail-content').hidden = true;
  showMessage(document.querySelector('#detail-message'), 'Loading user history…');
  try {
    const response = await fetch(`/api/users/${encodeURIComponent(id)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load user history.');
    const user = data.user;
    document.querySelector('#selected-name').textContent = `${user.first_name} ${user.last_name}`.trim();
    document.querySelector('#selected-email').textContent = user.email;
    const current = users.find((item) => item.id === id);
    document.querySelector('#selected-schedule').textContent = current?.profileComplete ? `Shift ${current.shiftNumber} · ${current.position}` : 'Profile incomplete';
    renderSchedules(data.schedules || []);
    const history = data.history || [];
    const categories = {
      open: data.open || [],
      pending: history.filter((swap) => swap.status === 'Submitted Pending'),
      accepted: history.filter((swap) => swap.status === 'Accepted By Core'),
      closed: history.filter((swap) => ['Denied By Core', 'Cancelled', 'Expired'].includes(swap.status)),
    };
    renderSwapGroup('panel-open', categories.open, 'open');
    renderSwapGroup('panel-pending', categories.pending, 'history');
    renderSwapGroup('panel-accepted', categories.accepted, 'history');
    renderSwapGroup('panel-closed', categories.closed, 'history');
    showMessage(document.querySelector('#detail-message'), '');
    document.querySelector('#detail-content').hidden = false;
  } catch (error) {
    document.querySelector('#detail-content').hidden = true;
    document.querySelector('#empty-detail').hidden = false;
    showMessage(document.querySelector('#detail-message'), error.message);
  }
}

async function initUsers() {
  try {
    const response = await fetch('/api/users');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load users.');
    users = data;
    renderUsers();
  } catch (error) { showMessage(document.querySelector('#users-message'), error.message); }
}

document.querySelectorAll('.swap-tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.swap-tab').forEach((button) => {
    const active = button === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.swap-panel').forEach((panel) => { panel.hidden = panel.id !== tab.getAttribute('aria-controls'); });
}));
initUsers();
