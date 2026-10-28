# Gestione-Guasti-Segnalazione

Portale per raccogliere segnalazioni di assistenza tecnica, organizzare gli interventi e supportare il team con un assistente tecnico.

## Avvio

Richiede Node.js 18 o successivo. Non servono dipendenze esterne. Le credenziali admin sono caricate dal file locale `.env`.

```bash
npm start
```

Apri <http://localhost:3000>. Per riavviare automaticamente il server durante lo sviluppo:

```bash
npm run dev
```

## Flussi disponibili

- I clienti scelgono tra segnalazione guasto, bug software, proposta di progetto e richiesta di supporto. Il modulo adatta titolo e campi alla categoria selezionata.
- Le richieste di progetto finiscono in una vista admin dedicata, con ricerca, stato, assegnatario e contatore in dashboard.
- L’area amministratore richiede login; la coda e le API di gestione non sono accessibili senza sessione.
- L’amministratore consulta e filtra la coda, assegna le richieste, aggiorna lo stato e prenota, sposta o annulla gli appuntamenti.
- Le prenotazioni usano slot feriali di un’ora tra le 09:00 e le 16:00; uno slot già preso non può essere assegnato a un’altra richiesta.
- Dashboard e agenda riepilogano le richieste aperte e gli appuntamenti attivi.
- L’assistente tecnico suggerisce controlli iniziali e propone date/orari liberi usando l’agenda. Senza configurazione esterna usa risposte locali; non è un modello generativo.

Al primo avvio è stato creato un account `admin`; la password iniziale è nel file `.env` locale. Cambiala prima di esporre il servizio. `.env` è escluso da Git; `.env.example` è il modello da usare per una nuova installazione. Se la porta 3000 è già occupata, cambia `PORT` in `.env` oppure termina il server precedente.

Le richieste sono salvate in `data/segnalazioni.json` sul server; il percorso può essere cambiato con `DATA_FILE`. Per abilitare risposte AI generative configura `AI_API_KEY`, `AI_API_URL` e `AI_MODEL` in `.env` con un provider compatibile con l’API chat completions. La richiesta dell’assistente viene inviata a quel provider. Questa versione non invia email o SMS e usa un archivio locale: per un servizio pubblico servono inoltre HTTPS, backup e un archivio condiviso.