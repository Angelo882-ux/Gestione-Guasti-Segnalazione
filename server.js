const http = require('node:http');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function loadEnvironment() {
	try {
		const content = fsSync.readFileSync(path.join(__dirname, '.env'), 'utf8');
		for (const line of content.split(/\r?\n/)) {
			const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
			if (!match || match[1] in process.env) continue;
			const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
			process.env[match[1]] = value;
		}
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
}

loadEnvironment();

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'Public');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'segnalazioni.json');
const STATUSES = new Set(['Nuova', 'In lavorazione', 'In attesa', 'Risolta']);
const ASSIGNEES = new Set(['Amministratore', 'Assistente']);
const REQUEST_TYPES = new Set(['Guasto', 'Bug', 'Progetto', 'Supporto']);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();
const appointmentHours = Array.from({ length: 8 }, (_, index) => `${String(index + 9).padStart(2, '0')}:00`);
const MIME_TYPES = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
};

let writeQueue = Promise.resolve();

async function readTickets() {
	try {
		return JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
	} catch (error) {
		if (error.code === 'ENOENT') return [];
		throw error;
	}
}

function updateTickets(operation) {
	const next = writeQueue.then(operation, operation);
	writeQueue = next.catch(() => {});
	return next;
}

async function saveTickets(tickets) {
	await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
	const temporaryFile = `${DATA_FILE}.${crypto.randomUUID()}.tmp`;
	await fs.writeFile(temporaryFile, JSON.stringify(tickets, null, 2));
	await fs.rename(temporaryFile, DATA_FILE);
}

function sendJson(response, statusCode, payload) {
	response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
	response.end(JSON.stringify(payload));
}

function safeEqual(first, second) {
	const firstBuffer = Buffer.from(first);
	const secondBuffer = Buffer.from(second);
	return firstBuffer.length === secondBuffer.length && crypto.timingSafeEqual(firstBuffer, secondBuffer);
}

function getSession(request) {
	const token = request.headers.cookie?.match(/(?:^|;\s*)prontodesk_session=([^;]+)/)?.[1];
	if (!token) return null;
	const session = sessions.get(token);
	if (!session || session.expiresAt <= Date.now()) {
		sessions.delete(token);
		return null;
	}
	return { token, ...session };
}

function requireAdmin(request, response) {
	if (getSession(request)) return true;
	sendJson(response, 401, { error: 'Accesso amministratore richiesto.' });
	return false;
}

function setSessionCookie(response, token, maxAge) {
	const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
	response.setHeader('Set-Cookie', `prontodesk_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

function getAppointmentDate(value) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
	const [year, month, day] = value.split('-').map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.toISOString().slice(0, 10) !== value) return null;
	return date;
}

function getAvailableSlots(dateValue, tickets, ignoredId = '') {
	const date = getAppointmentDate(dateValue);
	if (!date) return [];
	const dayOfWeek = date.getUTCDay();
	if (dayOfWeek === 0 || dayOfWeek === 6) return [];
	const today = new Date().toISOString().slice(0, 10);
	if (dateValue < today) return [];
	const booked = new Set(tickets
		.filter((ticket) => ticket.id !== ignoredId && ticket.appointmentDate === dateValue && ticket.status !== 'Risolta')
		.map((ticket) => ticket.appointmentTime));
	return appointmentHours.filter((time) => {
		if (booked.has(time)) return false;
		if (dateValue === today && Number(time.slice(0, 2)) <= new Date().getUTCHours()) return false;
		return true;
	});
}

function createLocalAssistantAnswer(question) {
	const normalized = question.toLocaleLowerCase('it');
	if (/\b(wi.?fi|rete|internet|connession)\b/.test(normalized)) {
		return 'Controlla prima se altri dispositivi navigano, verifica che il Wi-Fi sia attivo e riavvia modem e PC. Se il problema riguarda un solo dispositivo, dimentica e riconnetti la rete. Non condividere password di rete nella segnalazione.';
	}
	if (/\b(lento|lentezza|blocc|prestazion)\b/.test(normalized)) {
		return 'Salva il lavoro aperto, riavvia il PC e controlla Gestione attività per applicazioni che consumano molte risorse. Verifica spazio libero e aggiornamenti in sospeso. Evita di installare programmi di pulizia non autorizzati.';
	}
	if (/\b(stampant|stampa|stampare)\b/.test(normalized)) {
		return 'Verifica alimentazione, carta e collegamento; controlla che la stampante corretta sia selezionata e svuota eventuali lavori bloccati nella coda. Se compare un codice errore, annotalo nella segnalazione.';
	}
	if (/\b(schermo|monitor|nero|display)\b/.test(normalized)) {
		return 'Controlla alimentazione e cavo video, poi prova la combinazione per selezionare il display. Se il PC sembra acceso ma lo schermo resta nero, evita riavvii ripetuti e prenota un controllo tecnico.';
	}
	if (/\b(avvi|accend|boot|non parte)\b/.test(normalized)) {
		return 'Controlla alimentatore e presa, scollega periferiche non essenziali e prova un solo riavvio. Se compare una schermata di errore, fotografala o trascrivi il codice. Non aprire l’alimentatore del PC.';
	}
	if (/\b(password|account|access|login)\b/.test(normalized)) {
		return 'Controlla che il blocco maiuscole sia disattivato e verifica il nome utente. Usa soltanto il flusso ufficiale di recupero credenziali: non inserire né inviare la password nella segnalazione.';
	}
	return 'Per restringere il problema, annota il messaggio esatto, quando si presenta e cosa è cambiato di recente. Prova un riavvio controllato e salva il lavoro. Evita di condividere password o codici di accesso; se il problema persiste, apri una segnalazione e prenota un intervento.';
}

function suggestAppointmentSlots(tickets, requestedDate = '') {
	if (requestedDate) {
		const slots = getAvailableSlots(requestedDate, tickets);
		return slots.length
			? `Il ${new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(getAppointmentDate(requestedDate))} sono liberi: ${slots.slice(0, 5).join(', ')}${slots.length > 5 ? ', e altri orari' : ''}.`
			: 'Non trovo slot liberi in quella data. Prova un giorno feriale diverso.';
	}
	const suggestions = [];
	for (let offset = 0; offset < 21 && suggestions.length < 3; offset += 1) {
		const date = new Date();
		date.setUTCHours(0, 0, 0, 0);
		date.setUTCDate(date.getUTCDate() + offset);
		const dateValue = date.toISOString().slice(0, 10);
		const slots = getAvailableSlots(dateValue, tickets);
		if (slots.length) {
			suggestions.push(`${new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(date)}: ${slots.slice(0, 3).join(', ')}`);
		}
	}
	return suggestions.length
		? `Ecco alcune prime disponibilità:\n${suggestions.join('\n')}`
		: 'Non ci sono slot liberi nelle prossime tre settimane. Controlla l’agenda o prova più avanti.';
}

async function createAssistantAnswer(question) {
	if (!process.env.AI_API_KEY) {
		return { answer: createLocalAssistantAnswer(question), mode: 'locale' };
	}
	const baseUrl = (process.env.AI_API_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
	const response = await fetch(`${baseUrl}/chat/completions`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${process.env.AI_API_KEY}`, 'Content-Type': 'application/json' },
		signal: AbortSignal.timeout(15000),
		body: JSON.stringify({
			model: process.env.AI_MODEL || 'gpt-4o-mini',
			messages: [
				{ role: 'system', content: 'Sei un assistente tecnico per PC e prenotazioni di assistenza. Rispondi in italiano in modo conciso e prudente. Non chiedere password, non suggerire di disattivare protezioni e invita a rivolgersi a un tecnico per riparazioni hardware.' },
				{ role: 'user', content: question },
			],
			max_tokens: 350,
		}),
	});
	if (!response.ok) throw new Error('Il servizio AI non è disponibile. Controlla la configurazione e riprova.');
	const result = await response.json();
	const answer = result.choices?.[0]?.message?.content?.trim();
	if (!answer) throw new Error('Il servizio AI non ha restituito una risposta.');
	return { answer, mode: 'ai' };
}

async function readJsonBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > 1024 * 1024) {
			const error = new Error('Richiesta troppo grande.');
			error.statusCode = 413;
			throw error;
		}
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		const error = new Error('Il contenuto della richiesta non è un JSON valido.');
		error.statusCode = 400;
		throw error;
	}
}

function cleanText(value, maxLength = 500) {
	return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

async function handleApi(request, response, url) {
	if (url.pathname === '/api/session' && request.method === 'GET') {
		const session = getSession(request);
		return session
			? sendJson(response, 200, { authenticated: true, username: session.username })
			: sendJson(response, 401, { authenticated: false });
	}

	if (url.pathname === '/api/login' && request.method === 'POST') {
		if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
			return sendJson(response, 503, { error: 'Credenziali amministratore non configurate nel file .env.' });
		}
		const address = request.socket.remoteAddress || 'unknown';
		const attempts = loginAttempts.get(address) || { count: 0, blockedUntil: 0 };
		if (attempts.blockedUntil > Date.now()) {
			return sendJson(response, 429, { error: 'Troppi tentativi. Riprova tra un minuto.' });
		}
		const body = await readJsonBody(request);
		if (!safeEqual(cleanText(body.username, 100), ADMIN_USERNAME) || !safeEqual(String(body.password || ''), ADMIN_PASSWORD)) {
			attempts.count += 1;
			if (attempts.count >= 5) {
				attempts.count = 0;
				attempts.blockedUntil = Date.now() + 60_000;
			}
			loginAttempts.set(address, attempts);
			return sendJson(response, 401, { error: 'Nome utente o password non corretti.' });
		}
		loginAttempts.delete(address);
		const token = crypto.randomBytes(32).toString('base64url');
		sessions.set(token, { username: ADMIN_USERNAME, expiresAt: Date.now() + SESSION_TTL_MS });
		setSessionCookie(response, token, SESSION_TTL_MS / 1000);
		return sendJson(response, 200, { authenticated: true, username: ADMIN_USERNAME });
	}

	if (url.pathname === '/api/logout' && request.method === 'POST') {
		const session = getSession(request);
		if (session) sessions.delete(session.token);
		setSessionCookie(response, '', 0);
		return sendJson(response, 200, { authenticated: false });
	}

	if (url.pathname === '/api/slots' && request.method === 'GET') {
		const ticketId = getSession(request) ? url.searchParams.get('ticketId') || '' : '';
		return sendJson(response, 200, { date: url.searchParams.get('date') || '', slots: getAvailableSlots(url.searchParams.get('date'), await readTickets(), ticketId) });
	}

	if (url.pathname === '/api/assistant' && request.method === 'POST') {
		if (!requireAdmin(request, response)) return;
		const body = await readJsonBody(request);
		const question = cleanText(body.question, 1000);
		if (!question) return sendJson(response, 400, { error: 'Scrivi una domanda per l’assistente.' });
		if (/prenot|appuntament|orari? disponibili?|slot liberi?/i.test(question)) {
			const requestedDate = question.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] || '';
			return sendJson(response, 200, { answer: suggestAppointmentSlots(await readTickets(), requestedDate), mode: 'locale' });
		}
		return sendJson(response, 200, await createAssistantAnswer(question));
	}

	if (url.pathname === '/api/tickets' && request.method === 'GET') {
		if (!requireAdmin(request, response)) return;
		return sendJson(response, 200, await readTickets());
	}

	if (url.pathname === '/api/tickets' && request.method === 'POST') {
		const body = await readJsonBody(request);
		const ticket = {
			id: crypto.randomUUID(),
			requestType: REQUEST_TYPES.has(body.requestType) ? body.requestType : 'Guasto',
			customerName: cleanText(body.customerName, 100),
			contact: cleanText(body.contact, 150),
			device: cleanText(body.device, 120),
			category: cleanText(body.category, 80) || 'Altro',
			priority: ['Bassa', 'Normale', 'Alta', 'Urgente'].includes(body.priority) ? body.priority : 'Normale',
			title: cleanText(body.title, 140),
			description: cleanText(body.description, 2000),
			assignedTo: 'Assistente',
			status: 'Nuova',
			appointmentDate: cleanText(body.appointmentDate, 10),
			appointmentTime: cleanText(body.appointmentTime, 5),
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		if (!ticket.customerName || !ticket.contact || !ticket.title || !ticket.description || (ticket.requestType === 'Guasto' && !ticket.device)) {
			return sendJson(response, 400, { error: 'Compila tutti i campi obbligatori. Per un guasto indica anche il dispositivo.' });
		}
		if (Boolean(ticket.appointmentDate) !== Boolean(ticket.appointmentTime)) {
			return sendJson(response, 400, { error: 'Seleziona sia la data sia l’orario, oppure lascia entrambi vuoti.' });
		}

		await updateTickets(async () => {
			const tickets = await readTickets();
			if (ticket.appointmentDate && !getAvailableSlots(ticket.appointmentDate, tickets).includes(ticket.appointmentTime)) {
				const error = new Error('Questo orario non è disponibile. Scegli un altro slot feriale.');
				error.statusCode = 409;
				throw error;
			}
			tickets.unshift(ticket);
			await saveTickets(tickets);
		});
		return sendJson(response, 201, ticket);
	}

	const ticketMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)$/);
	if (ticketMatch && request.method === 'PATCH') {
		if (!requireAdmin(request, response)) return;
		const ticketId = decodeURIComponent(ticketMatch[1]);
		const body = await readJsonBody(request);
		const updatedTicket = await updateTickets(async () => {
			const tickets = await readTickets();
			const ticket = tickets.find((item) => item.id === ticketId);
			if (!ticket) return null;
			if (body.status !== undefined && !STATUSES.has(body.status)) {
				const error = new Error('Stato non valido.');
				error.statusCode = 400;
				throw error;
			}
			if (body.assignedTo !== undefined && !ASSIGNEES.has(body.assignedTo)) {
				const error = new Error('Assegnatario non valido.');
				error.statusCode = 400;
				throw error;
			}
			const nextDate = body.appointmentDate === undefined ? ticket.appointmentDate : cleanText(body.appointmentDate, 10);
			const nextTime = body.appointmentTime === undefined ? ticket.appointmentTime : cleanText(body.appointmentTime, 5);
			if (Boolean(nextDate) !== Boolean(nextTime)) {
				const error = new Error('Per modificare la prenotazione servono data e orario.');
				error.statusCode = 400;
				throw error;
			}
			if (nextDate && !getAvailableSlots(nextDate, tickets, ticketId).includes(nextTime)) {
				const error = new Error('Questo orario non è disponibile. Scegli un altro slot feriale.');
				error.statusCode = 409;
				throw error;
			}
			if (body.status !== undefined) ticket.status = body.status;
			if (body.assignedTo !== undefined) ticket.assignedTo = body.assignedTo;
			if (body.appointmentDate !== undefined) ticket.appointmentDate = nextDate;
			if (body.appointmentTime !== undefined) ticket.appointmentTime = nextTime;
			ticket.updatedAt = new Date().toISOString();
			await saveTickets(tickets);
			return ticket;
		});

		return updatedTicket
			? sendJson(response, 200, updatedTicket)
			: sendJson(response, 404, { error: 'Segnalazione non trovata.' });
	}

	return sendJson(response, 404, { error: 'Percorso API non trovato.' });
}

async function serveStatic(request, response, pathname) {
	let decodedPath;
	try {
		decodedPath = decodeURIComponent(pathname);
	} catch {
		response.writeHead(400).end('Percorso non valido.');
		return;
	}
	const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
	const filePath = path.resolve(PUBLIC_DIR, relativePath);
	if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
		response.writeHead(403).end('Accesso negato.');
		return;
	}
	try {
		const content = await fs.readFile(filePath);
		response.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
		response.end(content);
	} catch (error) {
		response.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Risorsa non disponibile.');
	}
}

const server = http.createServer(async (request, response) => {
	const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
	try {
		if (url.pathname.startsWith('/api/')) {
			await handleApi(request, response, url);
			return;
		}
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			response.writeHead(405, { Allow: 'GET, HEAD' }).end('Metodo non consentito.');
			return;
		}
		await serveStatic(request, response, url.pathname);
	} catch (error) {
		sendJson(response, error.statusCode || 500, { error: error.message || 'Errore interno del server.' });
	}
});

fs.mkdir(path.dirname(DATA_FILE), { recursive: true })
	.then(() => server.listen(PORT, () => console.log(`Gestione guasti disponibile su http://localhost:${PORT}`)))
	.catch((error) => {
		console.error('Impossibile inizializzare l’archivio:', error);
		process.exitCode = 1;
	});
