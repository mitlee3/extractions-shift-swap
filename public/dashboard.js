// Map database status values to dashboard badge classes.
function badgeClass(status) {
  const value = String(status).toLowerCase();
  if (value.includes('accepted') || value === 'selected') return 'badge-approved';
  if (value === 'open' || value === 'active' || value.includes('pending')) return 'badge-pending';
  if (value.includes('denied') || value.includes('withdrawn') || value.includes('cancelled') || value === 'expired') return 'badge-rejected';
  return 'badge-neutral';
}
function formatDate(value) {
  if (!value) return '—';
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})/.exec(String(value));
  if (!match) return String(value);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toLocaleDateString();
}
function addCell(row, value) {
  const cell = document.createElement('td');
  cell.textContent = value == null ? '—' : String(value);
  row.append(cell);
  return cell;
}
function renderTable(requests) {
  const tbody = document.querySelector('#swap-table-body');
  const message = document.querySelector('#requests-message');
  tbody.replaceChildren();
  for (const request of requests) {
    const row = document.createElement('tr');
    addCell(row, request.requester_name);
    addCell(row, request.offering_name || '—');
    addCell(row, formatDate(request.person_requesting_on));
    addCell(row, formatDate(request.person_offering_on));
    const statusCell = addCell(row, '');
    const badge = document.createElement('span');
    badge.className = `badge ${badgeClass(request.status)}`;
    badge.textContent = request.status || 'Unknown';
    statusCell.append(badge);
    tbody.append(row);
  }
  document.querySelector('#open-count').textContent = requests.filter((item) => item.status === 'Open').length;
  document.querySelector('#accepted-count').textContent = requests.filter((item) => item.status === 'Accepted By Core').length;
  document.querySelector('#pending-count').textContent = requests.filter((item) => item.status === 'Submitted Pending').length;
  message.textContent = requests.length ? '' : 'No shift swap requests found.';
}
async function loadDashboard() {
  try {
    const [userResponse, requestsResponse] = await Promise.all([fetch('/me'), fetch('/api/shift-requests')]);
    if (userResponse.status === 401) { window.location.assign('/'); return; }
    if (!userResponse.ok) throw new Error('Could not load your account.');
    if (!requestsResponse.ok) throw new Error('Could not load shift swap requests.');
    const [user, requests] = await Promise.all([userResponse.json(), requestsResponse.json()]);
    document.querySelector('#greeting').textContent = `Hello, ${user.name}`;
    renderTable(requests);
  } catch (error) { document.querySelector('#requests-message').textContent = error.message; }
}
const dialog = document.querySelector('#request-dialog');
document.querySelector('#open-request-btn').addEventListener('click', () => dialog.showModal());
document.querySelector('#close-dialog').addEventListener('click', () => dialog.close());
document.querySelector('#request-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.querySelector('#request-error');
  error.hidden = true;
  try {
    const response = await fetch('/api/shift-requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: document.querySelector('#request-date').value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not create the request.');
    dialog.close();
    document.querySelector('#request-form').reset();
    await loadDashboard();
  } catch (err) { error.textContent = err.message; error.hidden = false; }
});
loadDashboard();
