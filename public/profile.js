let csrfToken;
const isUpdatePage = window.location.pathname === '/profile/update';

function showError(message) {
  const errorElement = document.querySelector('#form-error');
  errorElement.textContent = message;
  errorElement.hidden = false;
}
function formatAvailability(value) {
  if (!value) return 'a month after your last profile update';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'a month after your last profile update' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}
function addSelectOptions(selector, values, placeholder, selected) {
  const select = document.querySelector(selector);
  select.replaceChildren();
  const empty = new Option(placeholder, '', true, !selected);
  empty.disabled = true;
  select.append(empty);
  values.forEach((value) => select.append(new Option(value, value, false, value === selected)));
}

async function initProfile() {
  try {
    const response = await fetch(isUpdatePage ? '/api/profile-update' : '/api/profile-options');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load profile options. Please reload.');
    csrfToken = data.csrfToken;

    if (isUpdatePage) {
      document.querySelector('#profile-kicker').textContent = 'Your profile';
      document.querySelector('#profile-title').textContent = 'Update your profile';
      document.querySelector('#profile-intro').textContent = 'You can update your profile once a month.';
      document.querySelector('#profile-submit').textContent = 'Save profile changes';
      document.querySelector('#first-name').value = data.firstName || '';
      document.querySelector('#last-name').value = data.lastName || '';
      const availability = document.querySelector('#availability-message');
      availability.hidden = false;
      availability.textContent = data.canUpdate
        ? 'Your monthly update is available now. After saving, your next update will be available one month later.'
        : `You have already updated your profile this month. You can make your next update on ${formatAvailability(data.availableAt)}.`;
      if (!data.canUpdate) {
        document.querySelectorAll('#profile-form input, #profile-form select, #profile-form button[type="submit"]').forEach((control) => { control.disabled = true; });
      }
    } else {
      document.querySelector('#first-name').value = data.firstName || '';
      document.querySelector('#last-name').value = data.lastName || '';
    }

    addSelectOptions('#position', data.options.positions, 'Select a position', data.position);
    addSelectOptions('#shift-number', data.options.shiftNumbers, 'Select a shift', data.shiftNumber);
    const days = document.querySelector('#shift-days');
    for (const day of data.options.shiftDays) {
      const label = document.createElement('label');
      label.className = 'day-option';
      const input = document.createElement('input');
      input.type = 'checkbox'; input.name = 'shiftDays'; input.value = String(day.value);
      input.checked = (data.shiftDays || []).map(Number).includes(Number(day.value));
      label.append(input, document.createTextNode(day.label));
      days.append(label);
    }
    if (isUpdatePage && !data.canUpdate) {
      document.querySelectorAll('#shift-days input').forEach((input) => { input.disabled = true; });
    }
  } catch (error) { showError(error.message); }
}

document.querySelector('#profile-form').addEventListener('submit', async (event) => {
  event.preventEvent?.();
});
