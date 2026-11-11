let csrfToken;

function addOptions(select, values, placeholder) {
  if (placeholder) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = placeholder;
    option.disabled = true;
    option.selected = true;
    select.append(option);
  }
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
}

fetch('/api/profile-options')
  .then(async (response) => {
    if (!response.ok) throw new Error('Could not load profile options. Please reload.');
    return response.json();
  })
  .then((data) => {
    csrfToken = data.csrfToken;
    document.querySelector('#first-name').value = data.firstName;
    document.querySelector('#last-name').value = data.lastName;
    addOptions(document.querySelector('#position'), data.options.positions, 'Select a position');
    addOptions(document.querySelector('#shift-days'), data.options.shiftDays);
    addOptions(document.querySelector('#shift-number'), data.options.shiftNumbers, 'Select a shift');
  })
  .catch((error) => {
    const errorElement = document.querySelector('#form-error');
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  });

document.querySelector('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorElement = document.querySelector('#form-error');
  errorElement.hidden = true;
  const selectedDays = [...document.querySelector('#shift-days').selectedOptions]
    .map((option) => option.value);
  try {
    const response = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        csrfToken,
        firstName: document.querySelector('#first-name').value,
        lastName: document.querySelector('#last-name').value,
        position: document.querySelector('#position').value,
        shiftDays: selectedDays,
        shiftNumber: document.querySelector('#shift-number').value,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not save your profile.');
    window.location.assign(result.redirect);
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  }
});
