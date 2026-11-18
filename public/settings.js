let csrfToken;

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

async function initSettings() {
  try {
    const response = await fetch('/api/profile-settings');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load profile settings.');
    csrfToken = data.csrfToken;

    document.querySelector('#current-name').textContent = `${data.firstName} ${data.lastName}`;
    document.querySelector('#current-position').textContent = data.position;
    document.querySelector('#current-shift').textContent = `Shift ${data.shiftNumber}`;
    const dayNames = data.options.shiftDays.filter((day) => data.shiftDays.includes(day.value)).map((day) => day.label);
    document.querySelector('#current-days').textContent = dayNames.join(', ');

    document.querySelector('#first-name').value = data.firstName;
    document.querySelector('#last-name').value = data.lastName;
    const position = document.querySelector('#position');
    const shift = document.querySelector('#shift-number');
    position.replaceChildren(...data.options.positions.map((value) => new Option(value, value)));
    shift.replaceChildren(...data.options.shiftNumbers.map((value) => new Option(value, value)));
    position.value = data.position;
    shift.value = data.shiftNumber;

    const days = document.querySelector('#shift-days');
    days.replaceChildren();
    for (const day of data.options.shiftDays) {
      const label = document.createElement('label');
      label.className = 'day-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'shiftDays';
      input.value = String(day.value);
      input.checked = data.shiftDays.includes(day.value);
      label.append(input, document.createTextNode(day.label));
      days.append(label);
    }

    const windowElement = document.querySelector('#update-window');
    if (!data.canUpdate) {
      windowElement.textContent = `Profile updates are limited to once every 30 days. You can update it again on ${formatDate(data.nextUpdateDate)}.`;
      windowElement.classList.add('locked');
      document.querySelector('#settings-fields').disabled = true;
      document.querySelector('#save-profile').disabled = true;
    } else {
      windowElement.textContent = 'You can update your profile now.';
    }
  } catch (error) {
    const element = document.querySelector('#form-error');
    element.textContent = error.message;
    element.hidden = false;
  }
}

document.querySelector('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.querySelector('#form-error');
  error.hidden = true;
  const payload = {
    csrfToken,
    firstName: document.querySelector('#first-name').value,
    lastName: document.querySelector('#last-name').value,
    position: document.querySelector('#position').value,
    shiftNumber: document.querySelector('#shift-number').value,
    shiftDays: [...document.querySelectorAll('#shift-days input:checked')].map((input) => Number(input.value)),
  };
  try {
    const response = await fetch('/api/profile-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not update your profile.');
    window.location.reload();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});

initSettings();
