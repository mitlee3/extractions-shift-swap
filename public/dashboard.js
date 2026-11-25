// Map server-side request states to the CSS badge colors used by the dashboard.
function badgeClass(status) {
  const value = String(status).toLowerCase();
  if (value.includes('accepted') || value === 'selected') return 'badge-approved';
  if (value === 'open' || value === 'active' || value.includes('pending')) return 'badge-pending';
  if (value.includes('denied') || value.includes('withdrawn') || value.includes('cancelled') || value === 'expired') return 'badge-rejected';
  return 'badge-neutral';
}

// Weekday labels correspond to the Monday-zero values stored in UserScheduleDays.
const weekdays = [
  { short: 'Mon', full: 'Monday' }, { short: 'Tue', full: 'Tuesday' },
  { short: 'Wed', full: 'Wednesday' }, { short: 'Thu', full: 'Thursday' },
  { short: 'Fri', full: 'Friday' }, { short: 'Sat', full: 'Saturday' },
  { short: 'Sun', full: 'Sunday' },
];

// Format a date-only value for display without showing a placeholder for missing dates.
function formatDate(value) {
  if (!value) return '—';
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})/.exec(String(value));
  if (!match) return String(value);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toLocaleDateString();
}

// Convert an ISO date to the app's Monday-zero weekday numbering, using UTC to avoid timezone shifts.
function weekdayFromDate(value) {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})/.exec(String(value || ''));
  return match
    ? (new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay() + 6) % 7
    : null;
}

// Create a text-only DOM element to safely display API-provided values.
function appendText(parent, tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value == null ? '' : String(value);
  parent.append(element);
  return element;
}

// Replace the three numeric summary cards with one centered, compact section heading.
function setupRequestHeading() {
  const headingContainer = document.querySelector('.stats-grid');
  if (!headingContainer) return;
  headingContainer.className = 'request-title-wrap';
  headingContainer.replaceChildren();
  const heading = appendText(headingContainer, 'h2', 'request-title', 'Open Shift Requests');
  headingContainer.setAttribute('aria-label', heading.textContent);
}

// Keep the signed-in user's current position and recurring days available during rendering and offer validation.
let currentUser = null;
let userWorkDays = [];
let activeOfferRequest = null;

// Only permit an offered date that the current user normally works and the requester does not.
function offerDateIsValid(value, request) {
  const day = weekdayFromDate(value);
  const requesterDays = (request.requester_shift_days || request.requester_days || []).map(Number);
  return day !== null && userWorkDays.includes(day) && !requesterDays.includes(day);
}

// Render open requests as compatibility-colored cards and show each requester's current workdays.
function renderRequests(allRequests) {
  const container = document.querySelector('#request-cards');
  const message = document.querySelector('#requests-message');
  const requests = allRequests.filter((request) => String(request.status).toLowerCase() === 'open');
  container.replaceChildren();

  // Compare each open request with both employees' schedule and position before building its card.
  for (const request of requests) {
    const userPosition = currentUser?.position;
    const requesterPosition = request.requester_position || request.position;
    const requestedDay = weekdayFromDate(request.person_requesting_on);
    const requesterDays = (request.requester_shift_days || request.requester_days || []).map(Number);
    // Collect every reason this request does not fit your schedule; it is compatible only when there are none.
    const reasons = [];
    if (requestedDay === null) reasons.push('Requested date is unavailable');
    else if (userWorkDays.includes(requestedDay)) reasons.push(`You already work ${weekdays[requestedDay].full}s`);
    if (!userWorkDays.some((day) => !requesterDays.includes(day))) reasons.push('You have no workday they have off to offer in return');
    if (!(userPosition && requesterPosition && userPosition === requesterPosition)) {
      reasons.push(userPosition && requesterPosition ? `Position not compatible (you: ${userPosition}, them: ${requesterPosition})` : 'Position not compatible');
    }
    const compatible = reasons.length === 0;
    const card = document.createElement('article');
    card.className = `request-bubble ${compatible ? 'compatible' : 'incompatible'}`;
    appendText(card, 'p', 'request-kicker', 'Day off requested');
    appendText(card, 'h4', 'request-date', formatDate(request.person_requesting_on));
    appendText(card, 'p', 'requester-name', request.requester_name || 'Team member');
    appendText(card, 'p', 'request-detail', requesterPosition ? `Position: ${requesterPosition}` : 'Position details unavailable');

    // Display all seven weekdays; filled circles indicate the requester's current recurring workdays.
    const schedule = document.createElement('div');
    schedule.className = 'request-schedule';
    appendText(schedule, 'span', 'schedule-label', 'Schedule:');
    const dayList = document.createElement('div');
    dayList.className = 'schedule-days';
    for (const [index, day] of weekdays.entries()) {
      const worksDay = requesterDays.includes(index);
      const chip = appendText(dayList, 'span', `schedule-day ${worksDay ? 'is-workday' : 'is-day-off'}`, day.short);
      chip.setAttribute('aria-label', `${day.full}: ${worksDay ? 'normally works' : 'not normally scheduled'}`);
      chip.title = `${day.full}: ${worksDay ? 'normally works' : 'not normally scheduled'}`;
    }
    schedule.append(dayList);
    card.append(schedule);

    // Show the compatibility result and a specific reason when a request cannot be offered on.
    const footer = document.createElement('div');
    footer.className = 'request-compatibility';
    appendText(footer, 'strong', '', compatible ? 'Compatible with your schedule.' : 'Not compatible with your schedule.');
    for (const reason of reasons) appendText(footer, 'span', 'compatibility-reason', reason);
    card.append(footer);

    // Only compatible requests receive a button to open the offer-date prompt.
    if (compatible) {
      const button = appendText(card, 'button', 'primary-btn offer-btn', 'Make offer');
      button.type = 'button';
      button.addEventListener('click', () => openOfferDialog(request));
    }
    container.append(card);
  }
  message.textContent = requests.length ? '' : 'There are no open shift requests right now.';
}

// Populate and show the offer dialog for the selected request.
function openOfferDialog(request) {
  activeOfferRequest = request;
  document.querySelector('#offer-request-summary').textContent = `Offer to cover ${request.requester_name || 'this request'} on ${formatDate(request.person_requesting_on)}.`;
  const dateInput = document.querySelector('#offer-date');
  dateInput.value = '';
  document.querySelector('#offer-date-help').textContent = 'Choose a day you normally work when the requesting employee is not regularly scheduled.';
  document.querySelector('#offer-error').hidden = true;
  document.querySelector('#offer-dialog').showModal();
}

// Load the signed-in account, open requests, and current profile schedule before rendering the dashboard.
async function loadDashboard() {
  try {
    const [userResponse, requestsResponse, scheduleResponse] = await Promise.all([
      fetch('/me'), fetch('/api/shift-requests'), fetch('/api/profile-settings'),
    ]);
    if (userResponse.status === 401) { window.location.assign('/'); return; }
    if (!userResponse.ok) throw new Error('Could not load your account.');
    if (!requestsResponse.ok) throw new Error('Could not load shift swap requests.');
    currentUser = await userResponse.json();
    const requests = await requestsResponse.json();
    if (scheduleResponse.ok) {
      const settings = await scheduleResponse.json();
      userWorkDays = (settings.shiftDays || []).map(Number);
      currentUser.position = settings.position || currentUser.position;
    }
    document.querySelector('#greeting').textContent = `Hello, ${currentUser.name}`;
    renderRequests(requests);
  } catch (error) {
    document.querySelector('#requests-message').textContent = error.message;
  }
}

// Wire up controls for opening and closing the create-request dialog.
const requestDialog = document.querySelector('#request-dialog');
document.querySelector('#open-request-btn').addEventListener('click', () => requestDialog.showModal());
document.querySelector('#close-dialog').addEventListener('click', () => requestDialog.close());

// Submit a new day-off request and refresh the dashboard when it succeeds.
document.querySelector('#request-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.querySelector('#request-error');
  error.hidden = true;
  const date = document.querySelector('#request-date').value;
  // Only days the user normally works can be requested off.
  if (!userWorkDays.includes(weekdayFromDate(date))) {
    error.textContent = 'You can only request a day off that you normally work.';
    error.hidden = false;
    return;
  }
  try {
    const response = await fetch('/api/shift-requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not create the request.');
    requestDialog.close();
    document.querySelector('#request-form').reset();
    await loadDashboard();
  } catch (err) { error.textContent = err.message; error.hidden = false; }
});

// Close the offer prompt without submitting an offer.
document.querySelector('#close-offer-dialog').addEventListener('click', () => document.querySelector('#offer-dialog').close());

// Validate and submit the selected work date, then reload open requests after a successful offer.
document.querySelector('#offer-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.querySelector('#offer-error');
  error.hidden = true;
  const date = document.querySelector('#offer-date').value;
  if (!activeOfferRequest || !offerDateIsValid(date, activeOfferRequest)) {
    error.textContent = 'Choose a date you normally work when the requesting employee is not regularly scheduled.';
    error.hidden = false;
    return;
  }
  try {
    const response = await fetch(`/api/shift-requests/${encodeURIComponent(activeOfferRequest.id)}/offers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not submit the offer.');
    document.querySelector('#offer-dialog').close();
    activeOfferRequest = null;
    await loadDashboard();
  } catch (err) { error.textContent = err.message; error.hidden = false; }
});

// Past dates cannot be requested or offered; stop the date pickers at today (the server enforces this too).
const now = new Date();
const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
document.querySelector('#request-date').min = localToday;
document.querySelector('#offer-date').min = localToday;

// Replace the former summary boxes with the compact open-requests heading.
setupRequestHeading();
// Fetch initial dashboard data once the page's deferred script runs.
loadDashboard();
