function badgeClass(status) {
  switch (String(status).toLowerCase()) {
    case 'approved':
      return 'badge-approved';
    case 'pending':
    case 'requesting':
      return 'badge-pending';
    case 'rejected':
      return 'badge-rejected';
    default:
      return 'badge-neutral';
  }
}

function formatDate(value) {
  if (!value) return '—';

  // PostgreSQL DATE may be serialized as YYYY-MM-DD or an ISO timestamp.
  const datePart = String(value).slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (!match) return String(value);

  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day)).toLocaleDateString();
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
    addCell(row, formatDate(request.person_requesting_off));
    addCell(row, formatDate(request.person_requesting_on));

    const statusCell = addCell(row, '');
    const badge = document.createElement('span');
    badge.className = `badge ${badgeClass(request.status)}`;
    badge.textContent = request.status || 'Unknown';
    statusCell.append(badge);
    tbody.append(row);
  }

  const approvedCount = requests.filter((request) => String(request.status).toLowerCase() === 'approved').length;
  const pendingCount = requests.filter((request) => ['pending', 'requesting'].includes(String(request.status).toLowerCase())).length;
  const openCount = requests.filter((request) => !['approved', 'rejected', 'cancelled', 'canceled'].includes(String(request.status).toLowerCase())).length;

  document.querySelector('#total-open').textContent = openCount;
  document.querySelector('#approved-count').textContent = approvedCount;
  document.querySelector('#pending-count').textContent = pendingCount;
  message.textContent = requests.length === 0 ? 'No shift swap requests found.' : '';
}

async function loadDashboard() {
  try {
    const [userResponse, requestsResponse] = await Promise.all([
      fetch('/me'),
      fetch('/api/shift-requests'),
    ]);

    if (userResponse.status === 401 || userResponse.status === 403) {
      window.location.assign('/');
      return;
    }
    if (!userResponse.ok) throw new Error('Could not load your account.');
    if (!requestsResponse.ok) throw new Error('Could not load shift swap requests.');

    const [user, requests] = await Promise.all([userResponse.json(), requestsResponse.json()]);
    document.querySelector('#greeting').textContent = `Hello, ${user.name}`;
    renderTable(requests);
  } catch (error) {
    const message = document.querySelector('#requests-message');
    message.textContent = error.message || 'Could not load shift swap requests. Please try again later.';
    message.setAttribute('role', 'alert');
  }
}

loadDashboard();
