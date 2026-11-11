const requests = [
  {
    employee: 'Ava Johnson',
    currentShift: 'Mon 7:00 AM – 3:00 PM',
    desiredShift: 'Tue 3:00 PM – 11:00 PM',
    status: 'Approved',
  },
  {
    employee: 'Marcus Lee',
    currentShift: 'Wed 11:00 AM – 7:00 PM',
    desiredShift: 'Thu 7:00 AM – 3:00 PM',
    status: 'Pending',
  },
  {
    employee: 'Nina Patel',
    currentShift: 'Fri 3:00 PM – 11:00 PM',
    desiredShift: 'Sat 7:00 AM – 3:00 PM',
    status: 'Rejected',
  },
  {
    employee: 'Daniel Kim',
    currentShift: 'Sun 7:00 AM – 3:00 PM',
    desiredShift: 'Mon 3:00 PM – 11:00 PM',
    status: 'Pending',
  },
];

function badgeClass(status) {
  switch (status.toLowerCase()) {
    case 'approved':
      return 'badge-approved';
    case 'pending':
      return 'badge-pending';
    case 'rejected':
      return 'badge-rejected';
    default:
      return 'badge-neutral';
  }
}

function renderTable() {
  const tbody = document.querySelector('#swap-table-body');

  tbody.innerHTML = requests.map((request) => `
    <tr>
      <td>${request.employee}</td>
      <td>${request.currentShift}</td>
      <td>${request.desiredShift}</td>
      <td><span class="badge ${badgeClass(request.status)}">${request.status}</span></td>
    </tr>
  `).join('');

  const totalOpen = requests.length;
  const approvedCount = requests.filter((request) => request.status === 'Approved').length;
  const pendingCount = requests.filter((request) => request.status === 'Pending').length;

  document.querySelector('#total-open').textContent = totalOpen;
  document.querySelector('#approved-count').textContent = approvedCount;
  document.querySelector('#pending-count').textContent = pendingCount;
}

fetch('/me')
  .then((response) => {
    if (!response.ok) throw new Error('Sign-in required');
    return response.json();
  })
  .then((user) => {
    document.querySelector('#greeting').textContent = `Hello, ${user.name}`;
  })
  .catch(() => {
    window.location.href = '/';
  });

renderTable();
