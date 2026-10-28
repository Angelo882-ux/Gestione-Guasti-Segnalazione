const STATUS_OPTIONS = ['Nuova', 'In lavorazione', 'In attesa', 'Risolta'];
const ASSIGNEE_OPTIONS = ['Assistente', 'Amministratore'];
const views = ['dashboard', 'tickets', 'appointments', 'projects', 'assistant', 'client'];
let tickets = [];
let isAuthenticated = false;
let activeRequestType = 'Guasto';

const elements = {
  breadcrumb: document.querySelector('#breadcrumb-current'),
  form: document.querySelector('#ticket-form'),
  formMessage: document.querySelector('#form-message'),
  submitButton: document.querySelector('#submit-ticket'),
  successPanel: document.querySelector('#success-panel'),
  ticketReference: document.querySelector('#ticket-reference'),
  loginModal: document.querySelector('#login-modal'),
  loginForm: document.querySelector('#login-form'),
  loginError: document.querySelector('#login-error'),
};

function formatDate(value, options = { day: 'numeric', month: 'short' }) {
  if (!value) return '';
  return new Intl.DateTimeFormat('it-IT', options).format(new Date(`${value}T12:00:00`));
}

function statusClass(status) {
  return `status-${status.replaceAll(' ', '-')}`;
}

function makeCellText(parent, tag, text, className = '') {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  parent.append(element);
  return element;
}

function createSelect(options, value, onChange, className = '') {
  const select = document.createElement('select');
  if (className) select.className = className;
  for (const option of options) {
    const item = document.createElement('option');
    item.value = option;
    item.textContent = option;
    item.selected = option === value;
    select.append(item);
  }
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

async function populateSlots(select, date, ticketId = '', selectedTime = '') {
  select.replaceChildren(new Option(date ? 'Caricamento orari...' : 'Scegli prima una data', ''));
  select.disabled = true;
  select.required = Boolean(date) && select.closest('#ticket-form') !== null;
  if (!date) return;
  const query = new URLSearchParams({ date });
  if (ticketId) query.set('ticketId', ticketId);
  try {
    const response = await fetch(`/api/slots?${query}`);
    if (!response.ok) throw new Error('Orari non disponibili.');
    const result = await response.json();
    select.replaceChildren(new Option(result.slots.length ? 'Seleziona un orario' : 'Nessuno slot disponibile', ''));
    for (const slot of result.slots) select.add(new Option(slot, slot));
    select.disabled = result.slots.length === 0;
    select.required = select.closest('#ticket-form') !== null;
    if (selectedTime && result.slots.includes(selectedTime)) select.value = selectedTime;
  } catch {
    select.replaceChildren(new Option('Impossibile caricare gli orari', ''));
    select.disabled = true;
  }
}

function createTicketRow(ticket, compact = false) {
  const row = document.createElement('tr');
  const person = document.createElement('td');
  person.className = 'person-cell';
  makeCellText(person, 'strong', ticket.customerName);
  makeCellText(person, 'small', ticket.device);
  row.append(person);

  const issue = document.createElement('td');
  issue.className = 'issue-cell';
  makeCellText(issue, 'strong', ticket.title);
  makeCellText(issue, 'small', `${ticket.requestType || 'Guasto'} · ${ticket.category}`);
  row.append(issue);

  const priority = document.createElement('td');
  makeCellText(priority, 'span', ticket.priority, `priority priority-${ticket.priority}`);
  row.append(priority);

  if (!compact) {
    const assignee = document.createElement('td');
    assignee.append(createSelect(ASSIGNEE_OPTIONS, ticket.assignedTo, (value) => updateTicket(ticket.id, { assignedTo: value })));
    row.append(assignee);
  }

  const status = document.createElement('td');
  if (compact) {
    makeCellText(status, 'span', ticket.status, `status-pill ${statusClass(ticket.status)}`);
  } else {
    status.append(createSelect(STATUS_OPTIONS, ticket.status, (value) => updateTicket(ticket.id, { status: value })));
  }
  row.append(status);
  return row;
}

function renderMetrics() {
  const openCount = tickets.filter((ticket) => ticket.status !== 'Risolta').length;
  const newCount = tickets.filter((ticket) => ticket.status === 'Nuova').length;
  const appointments = tickets.filter((ticket) => ticket.appointmentDate && ticket.status !== 'Risolta').length;
  const urgentCount = tickets.filter((ticket) => ticket.priority === 'Urgente' && ticket.status !== 'Risolta').length;
  const projectCount = tickets.filter((ticket) => ticket.requestType === 'Progetto' && ticket.status !== 'Risolta').length;
  const metrics = [
    { label: 'Richieste aperte', value: openCount, detail: `${newCount} da prendere in carico`, color: '#167a64' },
    { label: 'Nuove oggi', value: newCount, detail: 'In attesa di assegnazione', color: '#e48254' },
    { label: 'Appuntamenti attivi', value: appointments, detail: 'Interventi da pianificare', color: '#7185b0' },
    { label: 'Progetti aperti', value: projectCount, detail: 'Idee e miglioramenti', color: '#b67c39' },
    { label: 'Priorità urgente', value: urgentCount, detail: 'Richiedono attenzione', color: '#d76247' },
  ];
  const grid = document.querySelector('#metric-grid');
  grid.replaceChildren();
  for (const metric of metrics) {
    const card = document.createElement('article');
    card.className = 'metric-card';
    card.style.setProperty('--metric-color', metric.color);
    makeCellText(card, 'span', metric.label, 'metric-label');
    makeCellText(card, 'strong', String(metric.value), 'metric-number');
    makeCellText(card, 'span', metric.detail, 'metric-detail');
    grid.append(card);
  }
  document.querySelector('#nav-count').textContent = String(newCount);
  document.querySelector('#project-count').textContent = String(projectCount);
}

function renderDashboard() {
  const recent = tickets.filter((ticket) => ticket.status !== 'Risolta').slice(0, 5);
  const table = document.querySelector('#recent-tickets');
  table.replaceChildren(...recent.map((ticket) => createTicketRow(ticket, true)));
  document.querySelector('#dashboard-empty').classList.toggle('hidden', recent.length > 0);

  const upcoming = tickets
    .filter((ticket) => ticket.appointmentDate && ticket.status !== 'Risolta')
    .sort((a, b) => `${a.appointmentDate} ${a.appointmentTime}`.localeCompare(`${b.appointmentDate} ${b.appointmentTime}`))
    .slice(0, 4);
  const container = document.querySelector('#upcoming-appointments');
  container.replaceChildren(...upcoming.map(createPreviewAppointment));
  document.querySelector('#upcoming-empty').classList.toggle('hidden', upcoming.length > 0);
}

function createDateTile(date) {
  const tile = document.createElement('div');
  tile.className = 'date-tile';
  makeCellText(tile, 'strong', formatDate(date, { day: '2-digit' }));
  makeCellText(tile, 'span', formatDate(date, { month: 'short' }).replace('.', ''));
  return tile;
}

function createPreviewAppointment(ticket) {
  const item = document.createElement('div');
  item.className = 'preview-item';
  item.append(createDateTile(ticket.appointmentDate));
  const copy = document.createElement('div');
  copy.className = 'preview-copy';
  makeCellText(copy, 'strong', ticket.customerName);
  makeCellText(copy, 'small', `${ticket.appointmentTime || 'Orario da definire'} · ${ticket.device}`);
  item.append(copy);
  return item;
}

function renderTickets() {
  const query = document.querySelector('#ticket-search').value.trim().toLocaleLowerCase('it');
  const status = document.querySelector('#status-filter').value;
  const filtered = tickets.filter((ticket) => {
    const matchesText = `${ticket.customerName} ${ticket.device} ${ticket.title} ${ticket.category} ${ticket.requestType || 'Guasto'}`.toLocaleLowerCase('it').includes(query);
    return matchesText && (status === 'Tutte' || ticket.status === status);
  });
  document.querySelector('#all-tickets').replaceChildren(...filtered.map((ticket) => createTicketRow(ticket)));
  document.querySelector('#result-count').textContent = `${filtered.length} ${filtered.length === 1 ? 'risultato' : 'risultati'}`;
  document.querySelector('#tickets-empty').classList.toggle('hidden', filtered.length > 0);
}

function renderProjects() {
  const query = document.querySelector('#project-search').value.trim().toLocaleLowerCase('it');
  const projects = tickets.filter((ticket) => ticket.requestType === 'Progetto' && `${ticket.customerName} ${ticket.title} ${ticket.description}`.toLocaleLowerCase('it').includes(query));
  document.querySelector('#project-tickets').replaceChildren(...projects.map((ticket) => createTicketRow(ticket)));
  document.querySelector('#project-result-count').textContent = `${projects.length} ${projects.length === 1 ? 'progetto' : 'progetti'}`;
  document.querySelector('#projects-empty').classList.toggle('hidden', projects.length > 0);
}

function createAppointmentCard(ticket) {
  const card = document.createElement('article');
  card.className = 'appointment-card';
  if (ticket.appointmentDate) card.append(createDateTile(ticket.appointmentDate));
  else {
    const unscheduledTile = document.createElement('div');
    unscheduledTile.className = 'date-tile date-tile-open';
    makeCellText(unscheduledTile, 'strong', '+');
    makeCellText(unscheduledTile, 'span', 'Da fissare');
    card.append(unscheduledTile);
  }

  const info = document.createElement('div');
  info.className = 'appointment-info';
  makeCellText(info, 'strong', ticket.customerName);
  makeCellText(info, 'small', `${ticket.title} · ${ticket.device}`);
  card.append(info);

  const time = document.createElement('div');
  time.className = 'appointment-meta';
  makeCellText(time, 'strong', ticket.appointmentTime || 'Da concordare');
  makeCellText(time, 'span', ticket.assignedTo);
  card.append(time);

  const state = document.createElement('div');
  makeCellText(state, 'span', ticket.status, `status-pill ${statusClass(ticket.status)}`);
  card.append(state);

  const controls = document.createElement('div');
  controls.className = 'appointment-controls';
  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.value = ticket.appointmentDate;
  dateInput.setAttribute('aria-label', `Nuova data per ${ticket.customerName}`);
  const timeInput = document.createElement('select');
  timeInput.setAttribute('aria-label', `Nuovo orario per ${ticket.customerName}`);
  populateSlots(timeInput, ticket.appointmentDate, ticket.id, ticket.appointmentTime);
  dateInput.addEventListener('change', () => populateSlots(timeInput, dateInput.value, ticket.id));
  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.textContent = ticket.appointmentDate ? 'Sposta' : 'Prenota';
  saveButton.addEventListener('click', () => {
    if (!dateInput.value || !timeInput.value) {
      window.alert('Scegli una data feriale e uno slot libero.');
      return;
    }
    updateTicket(ticket.id, { appointmentDate: dateInput.value, appointmentTime: timeInput.value });
  });
  controls.append(dateInput, timeInput, saveButton);
  if (ticket.appointmentDate) {
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'cancel-appointment';
    cancelButton.textContent = 'Annulla';
    cancelButton.setAttribute('aria-label', `Annulla appuntamento per ${ticket.customerName}`);
    cancelButton.addEventListener('click', () => {
      if (window.confirm(`Annullare l’appuntamento di ${ticket.customerName}?`)) {
        updateTicket(ticket.id, { appointmentDate: '', appointmentTime: '' });
      }
    });
    controls.append(cancelButton);
  }
  card.append(controls);
  return card;
}

function renderAppointments() {
  const appointments = tickets
    .filter((ticket) => ticket.status !== 'Risolta')
    .sort((a, b) => `${a.appointmentDate || '9999-12-31'} ${a.appointmentTime}`.localeCompare(`${b.appointmentDate || '9999-12-31'} ${b.appointmentTime}`));
  document.querySelector('#appointment-list').replaceChildren(...appointments.map(createAppointmentCard));
  document.querySelector('#appointments-empty').classList.toggle('hidden', tickets.some((ticket) => ticket.status !== 'Risolta'));
}

function render() {
  renderMetrics();
  renderDashboard();
  renderTickets();
  renderProjects();
  renderAppointments();
}

async function loadTickets() {
  const response = await fetch('/api/tickets');
  if (response.status === 401) {
    setAuthenticated(false);
    throw new Error('La sessione è scaduta. Accedi di nuovo.');
  }
  if (!response.ok) throw new Error('Non è stato possibile caricare le segnalazioni.');
  tickets = await response.json();
  render();
}

async function updateTicket(id, changes) {
  try {
    const response = await fetch(`/api/tickets/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || 'Aggiornamento non riuscito.');
    }
    const updated = await response.json();
    tickets = tickets.map((ticket) => ticket.id === updated.id ? updated : ticket);
    render();
  } catch (error) {
    window.alert(error.message);
  }
}

function switchView(name) {
  if (!views.includes(name)) return;
  if (name !== 'client' && !isAuthenticated) {
    showLogin();
    return;
  }
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('is-visible', view.id === `view-${name}`));
  document.querySelectorAll('.nav-link[data-view]').forEach((button) => {
    const sameView = button.dataset.view === name;
    const sameRequest = name !== 'client' || button.dataset.requestType === activeRequestType;
    button.classList.toggle('is-active', sameView && sameRequest);
  });
  const labels = { dashboard: 'Panoramica', tickets: 'Segnalazioni', appointments: 'Prenotazioni', projects: 'Progetti', assistant: 'Assistente tecnico', client: 'Area servizi' };
  elements.breadcrumb.textContent = labels[name];
  window.history.replaceState(null, '', `#${name}`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setRequestType(requestType) {
  const settings = {
    Guasto: { heading: 'Segnala un guasto.', description: 'Descrivi cosa non funziona e il team assistenza prenderà in carico la richiesta.', title: 'Titolo del problema', placeholder: 'Es. Il PC non si avvia', device: 'Dispositivo interessato', devicePlaceholder: 'Es. PC ufficio, modello o numero inventario', category: 'Tipo di guasto', categories: ['Computer / PC', 'Stampante', 'Rete e connessione', 'Software', 'Account e accessi', 'Altro'], required: true },
    Bug: { heading: 'Segnala un bug.', description: 'Indica l’applicazione, i passaggi per riprodurre l’errore e il risultato atteso.', title: 'Titolo del bug', placeholder: 'Es. Il pulsante Salva non risponde', device: 'Applicazione o dispositivo', devicePlaceholder: 'Nome app, browser e versione (facoltativo)', category: 'Categoria bug', categories: ['Software', 'Sito web', 'Applicazione', 'Altro'], required: false },
    Progetto: { heading: 'Proponi un progetto.', description: 'Racconta l’obiettivo, chi ne beneficerà e quale miglioramento ti aspetti.', title: 'Nome del progetto', placeholder: 'Es. Portale per richieste interne', device: 'Area o reparto coinvolto', devicePlaceholder: 'Es. Amministrazione (facoltativo)', category: 'Area progetto', categories: ['Nuovo strumento', 'Automazione', 'Miglioramento processo', 'Altro'], required: false },
    Supporto: { heading: 'Richiedi supporto.', description: 'Indica l’attività per cui ti serve una mano e il momento più comodo per un intervento.', title: 'Oggetto della richiesta', placeholder: 'Es. Configurazione nuovo account', device: 'Servizio o dispositivo', devicePlaceholder: 'Specifica l’area interessata (facoltativo)', category: 'Area di supporto', categories: ['Account e accessi', 'Configurazione', 'Formazione', 'Altro'], required: false },
  };
  const selected = settings[requestType] || settings.Guasto;
  activeRequestType = settings[requestType] ? requestType : 'Guasto';
  elements.form.elements.requestType.value = activeRequestType;
  document.querySelector('#request-heading').textContent = selected.heading;
  document.querySelector('#request-description').textContent = selected.description;
  const deviceLabel = document.querySelector('#device-field');
  deviceLabel.firstChild.textContent = selected.device;
  deviceLabel.querySelector('input').placeholder = selected.devicePlaceholder;
  deviceLabel.querySelector('.required-marker').classList.toggle('hidden', !selected.required);
  deviceLabel.querySelector('input').required = selected.required;
  const titleLabel = document.querySelector('#title-field');
  titleLabel.firstChild.textContent = selected.title;
  titleLabel.querySelector('input').placeholder = selected.placeholder;
  const categoryField = document.querySelector('#category-field');
  categoryField.firstChild.textContent = selected.category;
  categoryField.querySelector('select').replaceChildren(...selected.categories.map((category) => new Option(category, category)));
}

function showLogin() {
  elements.loginError.textContent = '';
  elements.loginModal.classList.remove('hidden');
  elements.loginForm.elements.username.focus();
}

function setAuthenticated(authenticated, username = '') {
  isAuthenticated = authenticated;
  document.querySelectorAll('.staff-only').forEach((element) => element.classList.toggle('hidden', !authenticated));
  document.querySelector('#admin-login-trigger').classList.toggle('hidden', authenticated);
  document.querySelector('#admin-session').classList.toggle('hidden', !authenticated);
  document.querySelector('#admin-username').textContent = username;
  if (!authenticated) {
    tickets = [];
    render();
    if (document.querySelector('#view-client').classList.contains('is-visible') === false) switchView('client');
  }
}

async function enterAdmin(username) {
  setAuthenticated(true, username);
  elements.loginModal.classList.add('hidden');
  await loadTickets();
  switchView('dashboard');
}

async function sendAssistantQuestion(question) {
  const messages = document.querySelector('#assistant-messages');
  const userMessage = document.createElement('div');
  userMessage.className = 'chat-message user-message';
  userMessage.textContent = question;
  messages.append(userMessage);
  const pending = document.createElement('div');
  pending.className = 'chat-message assistant-message';
  pending.textContent = 'Sto preparando una risposta...';
  messages.append(pending);
  messages.scrollTop = messages.scrollHeight;
  try {
    const response = await fetch('/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Assistente non disponibile.');
    pending.textContent = result.answer;
    document.querySelector('#assistant-mode').textContent = result.mode === 'ai' ? 'AI collegata' : 'Modalità locale';
  } catch (error) {
    pending.textContent = error.message;
    pending.classList.add('chat-error');
  }
  messages.scrollTop = messages.scrollHeight;
}

document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.requestType) {
    const clientViewOpen = document.querySelector('#view-client').classList.contains('is-visible');
    if (!clientViewOpen || button.dataset.requestType !== activeRequestType || elements.form.classList.contains('hidden')) {
      elements.form.reset();
      elements.form.classList.remove('hidden');
      elements.successPanel.classList.add('hidden');
      elements.formMessage.textContent = '';
    }
    setRequestType(button.dataset.requestType);
  }
  switchView(button.dataset.view);
}));
document.querySelector('#ticket-search').addEventListener('input', renderTickets);
document.querySelector('#status-filter').addEventListener('change', renderTickets);
document.querySelector('#project-search').addEventListener('input', renderProjects);
document.querySelector('#request-type').addEventListener('change', (event) => setRequestType(event.target.value));
document.querySelector('#agenda-date').textContent = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
document.querySelector('#today-label').textContent = new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date());
document.querySelector('#admin-login-trigger').addEventListener('click', showLogin);
document.querySelector('#login-close').addEventListener('click', () => elements.loginModal.classList.add('hidden'));
elements.loginModal.addEventListener('click', (event) => {
  if (event.target === elements.loginModal) elements.loginModal.classList.add('hidden');
});
elements.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = elements.loginForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  elements.loginError.textContent = '';
  const payload = Object.fromEntries(new FormData(elements.loginForm).entries());
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Accesso non riuscito.');
    elements.loginForm.reset();
    await enterAdmin(result.username);
  } catch (error) {
    elements.loginError.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
document.querySelector('#admin-logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  setAuthenticated(false);
});
document.querySelector('#assistant-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.querySelector('#assistant-question');
  const question = input.value.trim();
  if (!question) return;
  input.value = '';
  await sendAssistantQuestion(question);
});
document.querySelectorAll('.prompt-button').forEach((button) => button.addEventListener('click', () => sendAssistantQuestion(button.dataset.question)));

const clientDate = elements.form.elements.appointmentDate;
const clientTime = elements.form.elements.appointmentTime;
clientDate.min = new Date().toISOString().slice(0, 10);
clientDate.addEventListener('change', () => populateSlots(clientTime, clientDate.value));

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.formMessage.textContent = '';
  const formData = new FormData(elements.form);
  const payload = Object.fromEntries(formData.entries());
  elements.submitButton.disabled = true;
  elements.submitButton.textContent = 'Invio in corso...';
  try {
    const response = await fetch('/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Invio non riuscito.');
    tickets.unshift(result);
    render();
    elements.ticketReference.textContent = `#${result.id.slice(0, 8).toUpperCase()}`;
    elements.form.classList.add('hidden');
    elements.successPanel.classList.remove('hidden');
  } catch (error) {
    elements.formMessage.textContent = error.message;
  } finally {
    elements.submitButton.disabled = false;
    elements.submitButton.innerHTML = 'Invia segnalazione <span>→</span>';
  }
});

document.querySelector('#new-ticket-button').addEventListener('click', () => {
  elements.form.reset();
  elements.form.classList.remove('hidden');
  elements.successPanel.classList.add('hidden');
  elements.formMessage.textContent = '';
});

switchView('client');
fetch('/api/session').then(async (response) => {
  if (!response.ok) return;
  const session = await response.json();
  if (session.authenticated) await enterAdmin(session.username);
}).catch(() => {});