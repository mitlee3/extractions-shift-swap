let csrfToken;

// Load profile defaults and construct options that match database constraints.
async function initProfile() {
  try {
    const response = await fetch('/api/profile-options');
    if (!response.ok) throw new Error('Could not load profile options. Please reload.');

    const data = await response.json();
    csrfToken = data.csrfToken;

    document.querySelector('#first-name').value = data.firstName;
    document.querySelector('#last-name').value = data.lastName;

    addSelectOptions('#position', data.options.positions, 'Select a position');
    addSelectOptions('#shift-number', data.options.shiftNumbers, 'Select a shift');

    // Each checkbox stores a day_of_week value in UserScheduleDays.
    const days = document.querySelector('#shift-days');
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

// Replace a select with a placeholder and valid database choices.
function addSelectOptions(selector, values, placeholder) {
  const select = document.querySelector(selector);
  select.replaceChildren();

  const empty = new Option(placeholder, '', true, true);
  empty.disabled = true;
  select.append(empty);

  values.forEach((value) => select.append(new Option(value, value)));
}

// Display validation or API errors in the accessible form alert region.
function showError(message) {
  const errorElement = document.querySelector('#form-error');
  errorElement.textContent = message;
  errorElement.hidden = false;
}

// Submit User fields and normalized recurring weekdays to the server.
document.querySelector('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  document.querySelector('#form-error').hidden = true;

  const shiftDays = [...document.querySelectorAll('input[name="shiftDays"]:checked')]
    .map((input) => Number(input.value));

  try {
    const response = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        csrfToken,
        firstName: document.querySelector('#first-name').value,
        lastName: document.querySelector('#last-name').value,
        position: document.querySelector('#position').value,
        shiftNumber: document.querySelector('#shift-number').value,
        shiftDays,
      }),
    });

    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not save your profile.');
    window.location.assign(result.redirect);
  } catch (error) {
    showError(error.message);
  }
});

// Initialize the profile form after the deferred script loads.
initProfile();
