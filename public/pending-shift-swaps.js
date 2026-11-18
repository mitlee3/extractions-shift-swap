const list = document.querySelector('#pending-list');
const message = document.querySelector('#pending-message');
const dialog = document.querySelector('#decision-dialog');
let selectedSwap = null;
let selectedAction = null;

function makeElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text == null ? '' : String(text);
  return node;
}
function formatDate(value) {
  if (!value) return 'Date unavailable';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  const date = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function showMessage(text) { message.textContent = text; message.hidden = !text; }

function renderSwaps(swaps) {
  list.replaceChildren();
  if (!swaps.length) {
    list.append(makeElement('p', 'empty-pending', 'There are no pending shift swaps.'));
    return;
  }
  for (const swap of swaps) {
    const card = makeElement('article', 'pending-swap-card');
    const summary = makeElement('div', 'swap-summary');
    const heading = makeElement('h3', '', `${swap.requester_name} ↔ ${swap.offering_name}`);
    summary.append(heading);
    summary.append(makeElement('p', '', `Requested by ${swap.requester_name} (${swap.requester_email})`));
    summary.append(makeElement('p', '', `Offering ${swap.offering_name} (${swap.offering_email})`));
    const dates = makeElement('div', 'swap-dates');
    dates.append(makeElement('div', '', `Requester day off: ${formatDate(swap.person_requesting_on)}`));
    dates.append(makeElement('div', '', `Offer date: ${formatDate(swap.person_offering_on)}`));
    dates.append(makeElement('div', '', `Submitted: ${formatDate(swap.submitted_at)}`));
    summary.append(dates);
    const actions = makeElement('div', 'swap-actions');
    const approve = makeElement('button', 'approve-btn', 'Approve');
    approve.type = 'button';
    approve.addEventListener('click', () => openDecision(swap, 'approve'));
    const deny = makeElement('button', 'deny-btn', 'Deny');
    deny.type = 'button';
    deny.addEventListener('click', () => openDecision(swap, 'deny'));
    actions.append(approve, deny);
    card.append(summary, actions);
    list.append(card);
  }
}

async function loadSwaps() {
  list.replaceChildren();
  showMessage('Loading pending shift swaps…');
  try {
    const response = await fetch('/api/pending-shift-swaps', { headers: { Accept: 'application/json' } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load pending shift swaps.');
    renderSwaps(data);
    showMessage('');
  } catch (error) { showMessage(error.message); }
}

function openDecision(swap, action) {
  selectedSwap = swap;
  selectedAction = action;
  const isApproval = action === 'approve';
  document.querySelector('#dialog-title').textContent = isApproval ? 'Approve shift swap?' : 'Deny shift swap?';
  document.querySelector('#dialog-description').textContent = isApproval
    ? "The status of the request will be changed to 'Approved'. Users are notified with the disclaimer this is not official until Calendar invites are accepted, which you must send manually."
    : 'The status of the request will be changed to denied. This cannot be undone. Would you like to provide details to be sent to the Users?';
  document.querySelector('#confirm-decision').textContent = isApproval ? 'Yes, confirm' : 'Yes, deny';
  document.querySelector('#confirm-decision').className = isApproval ? 'primary-btn' : 'danger-btn';
  document.querySelector('#deny-message-field').hidden = isApproval;
  document.querySelector('#denied-message').value = '';
  document.querySelector('#character-count').textContent = '0';
  document.querySelector('#dialog-error').hidden = true;
  dialog.showModal();
}

async function confirmDecision(event) {
  event.preventDefault();
  if (!selectedSwap || !selectedAction) return;
  const confirmButton = document.querySelector('#confirm-decision');
  confirmButton.disabled = true;
  const error = document.querySelector('#dialog-error');
  error.hidden = true;
  try {
    const response = await fetch(`/api/pending-shift-swaps/${encodeURIComponent(selectedSwap.id)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ action: selectedAction, deniedMessage: document.querySelector('#denied-message').value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not update this shift swap.');
    dialog.close();
    selectedSwap = null;
    selectedAction = null;
    await loadSwaps();
  } catch (problem) {
    error.textContent = problem.message;
    error.hidden = false;
  } finally { confirmButton.disabled = false; }
}

document.querySelector('#decision-form').addEventListener('submit', confirmDecision);
document.querySelector('#close-dialog').addEventListener('click', () => dialog.close());
document.querySelector('#cancel-decision').addEventListener('click', () => dialog.close());
document.querySelector('#refresh-swaps').addEventListener('click', loadSwaps);
document.querySelector('#denied-message').addEventListener('input', (event) => {
  document.querySelector('#character-count').textContent = String(event.target.value.length);
});
dialog.addEventListener('close', () => { selectedSwap = null; selectedAction = null; });
loadSwaps();
