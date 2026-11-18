// Hold the one-time token returned by the server to authorize profile creation.
let csrfToken;

// Display profile-loading or submission errors in the form's accessible alert.
function showError(message) {
  const errorElement = document.querySelector('#form-error');
  errorElement.textContent = message;
  errorElement.hidden = false;
}

// Populate a select menu with a disabled prompt followed by the server-provided choices.
function addSelectOptions(selector, values, placeholder) {
  const select = document.querySelector(selector);
  select.replaceChildren();
  const empty = new Option(placeholder, '', true, true);
  empty.disabled = true;
  select.append(empty);
  values.forEach((value) => select.append(new Option(value, value)));
}

// Load saved name suggestions and profile choices, then build weekday checkbox controls.
async function initProfile() {
  try {
    const response = await fetch('/api/profile-options');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load profile options. Please reload.');
    csrfToken = data.csrfToken;
    document.querySelector('#first-name').value = data.firstName || '';
    document.querySelector('#last-name').value = data.lastName || '';
    addSelectOptions('#position', data.options.positions, 'Select a position');
    addSelectOptions('#shift-number', data.options.shiftNumbers, 'Select a shift');

    // Create one checkbox for each weekday option supplied by the server.
    const days = document.querySelector('#shift-days');
    days.replaceChildren();
    for (const day of data.options.shiftDays) {
      const label = document.createElement('label');
      label.className = 'day-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'shiftDays';
      input.value = String(day.value);
      label.append(input, document.createTextNode(day.label));
      days.append(label);
    }
  } catch (error) {
    showError(error.message);
  }
}

// Collect profile fields, submit them with the CSRF token, and navigate after successful creation.
document.querySelector('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorElement = document.querySelector('#form-error');
  errorElement.hidden = true;
  const form = event.currentTarget;
  const payload = {
    csrfToken,
    firstName: document.querySelector('#first-name').value,
    lastName: document.querySelector('#last-name').value,
    position: document.querySelector('#position').value,
    shiftNumber: document.querySelector('#shift-number').value,
    shiftDays: [...document.querySelectorAll('#shift-days input:checked')].map((input) => Number(input.value)),
  };
  try {
    const response = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not save your profile.');
    window.location.assign(result.redirect || '/dashboard');
  } catch (error) {
    showError(error.message);
  }
});

// Initialize the profile form when its page loads.
initProfile();
