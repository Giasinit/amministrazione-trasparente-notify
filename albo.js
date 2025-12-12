const fs = require("fs");
require("dotenv").config();

const headers = {
  "x-inertia": "true",
  "x-inertia-version": "0c651f0cc4f691db3f4418d733314948",
};

const SNAPSHOT_FILE = "last_snapshot_albo.json";
const CHECK_INTERVAL = 15 * 60 * 1000;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const CODICE_MECCANOGRAFICO = process.env.CODICE_MECCANOGRAFICO;

async function fetchAlbo(page = 1, acc = []) {
  try {
    const res = await fetch(
      `https://web.spaggiari.eu/sdg2/AlboOnline/${CODICE_MECCANOGRAFICO}?idCategoria=0&page=${page}`,
      { headers }
    );

    const text = await res.text();
    const data = JSON.parse(text);

    const docs = data.props?.documenti?.data || [];
    acc.push(...docs);

    const lastLink = data.props?.documenti?.links?.at(-1);

    console.log(`➡️ Pagina ${page}: ${docs.length} documenti`);

    if (lastLink && lastLink.url && !lastLink.active) {
      return fetchAlbo(page + 1, acc);
    }

    return acc;
  } catch (err) {
    console.error("❌ Errore:", err);
    return acc;
  }
}

async function checkForChanges(currentDocs) {
  const isFirstRun = !fs.existsSync(SNAPSHOT_FILE);

  if (isFirstRun) {
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(currentDocs, null, 2));
    console.log("🆕 Prima esecuzione ALBO: snapshot creato, nessun webhook.");
    return;
  }

  const previousDocs = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
  const prevMap = new Map(previousDocs.map(d => [d.id, JSON.stringify(d)]));

  for (const doc of currentDocs) {
    const currValue = JSON.stringify(doc);

    if (!prevMap.has(doc.id)) {
      await sendDiscordAlert(
        `🆕 Nuovo atto ALBO\n` +
        `ID: ${doc.id}\n` +
        `Oggetto: ${doc.documento?.protocollo?.oggetto || "N/D"}\n` +
        `Categoria: ${doc.categoria?.descrizione_class || "N/D"}\n` +
        `File: ${doc.documento?.nome_file_origine || "N/D"}\n` +
        `${doc.documento?.url || ""}`
      );
    } else if (prevMap.get(doc.id) !== currValue) {
      await sendDiscordAlert(
        `⚠️ Atto ALBO modificato\n` +
        `ID: ${doc.id}\n` +
        `Oggetto: ${doc.documento?.protocollo?.oggetto || "N/D"}\n` +
        `Categoria: ${doc.categoria?.descrizione_class || "N/D"}\n` +
        `File: ${doc.documento?.nome_file_origine || "N/D"}\n` +
        `${doc.documento?.url || ""}`
      );
    }
  }

  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(currentDocs, null, 2));
}

async function sendDiscordAlert(message) {
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "<@817382428653125723>\n" + message
      })
    });
  } catch (err) {
    console.error("❌ Errore webhook Discord:", err);
  }
}

async function run() {
  console.log("🔍 Controllo ALBO online...");
  const flatResult = await fetchAlbo();
  await checkForChanges(flatResult);
  fs.writeFileSync(new Date().toDateString() + "_albo_flat.json", JSON.stringify(flatResult, null, 2));
  console.log(`✅ Totale atti ALBO: ${flatResult.length}`);
}

run();
setInterval(run, CHECK_INTERVAL);
