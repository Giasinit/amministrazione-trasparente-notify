const fs = require("fs");
require("dotenv").config();

const headers = {
  "x-inertia": "true",
  "x-inertia-version": "0c651f0cc4f691db3f4418d733314948",
};

const SNAPSHOT_FILE = "last_snapshot_flat.json";
const CHECK_INTERVAL = 15 * 60 * 1000;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const CODICE_MECCANOGRAFICO = process.env.CODICE_MECCANOGRAFICO;

async function fetchCategorie() {
  try {
    const res = await fetch(`https://web.spaggiari.eu/sdg2/Trasparenza/${CODICE_MECCANOGRAFICO}?idCategoria=0`, {
      headers,
    });

    const text = await res.text();
    const data = JSON.parse(text);

    function collectIds(categorie, acc = []) {
      for (const cat of categorie) {
        acc.push(cat.id);
        if (Array.isArray(cat.sub_categorie) && cat.sub_categorie.length > 0) {
          collectIds(cat.sub_categorie, acc);
        }
      }
      return acc;
    }

    console.log("🔍 Controllo categorie...");
    const allIds = collectIds(data.props.categorie);
    console.log(`➡️ Trovate ${allIds.length} categorie.`);

    const resultsArray = await Promise.all(
      allIds.map(async (id) => fetchCategorieURL(id))
    );

    const flatResult = resultsArray.flat();
    await checkForChanges(flatResult);

    fs.writeFileSync(new Date().toDateString() + "_data_flat.json", JSON.stringify(flatResult, null, 2));
    console.log(`✅ Salvati ${flatResult.length} documenti totali`);
  } catch (err) {
    console.error("❌ Errore:", err);
  }
}

async function checkForChanges(currentDocs) {
  const isFirstRun = !fs.existsSync(SNAPSHOT_FILE);

  if (isFirstRun) {
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(currentDocs, null, 2));
    console.log("🆕 Prima esecuzione: snapshot creato, nessun webhook inviato.");
    return;
  }

  const previousDocs = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));

  const prevMap = new Map(previousDocs.map(d => [d.id, JSON.stringify(d)]));

  for (const doc of currentDocs) {
    const currValue = JSON.stringify(doc);

    if (!prevMap.has(doc.id)) {
      await sendDiscordAlert(
        `🆕 Nuovo documento\n` +
        `ID: ${doc.id}\n` +
        `File: ${doc.documento?.nome_file_origine || "N/D"}\n` +
        `Categoria: ${doc.categoria?.descrizione_class || "N/D"}\n` +
        `${doc.documento?.url || ""}`
      );
    } else if (prevMap.get(doc.id) !== currValue) {
      await sendDiscordAlert(
        `⚠️ Documento modificato\n` +
        `ID: ${doc.id}\n` +
        `File: ${doc.documento?.nome_file_origine || "N/D"}\n` +
        `Categoria: ${doc.categoria?.descrizione_class || "N/D"}\n` +
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
      body: JSON.stringify({ content: "<@817382428653125723>\n"+message })
    });
  } catch (err) {
    console.error("❌ Errore webhook Discord:", err);
  }
}

async function fetchCategorieURL(categoriaId, page = 1) {
  try {
    const res = await fetch(
      `https://web.spaggiari.eu/sdg2/Trasparenza/${CODICE_MECCANOGRAFICO}?idCategoria=${categoriaId}&page=${page}`,
      { headers }
    );

    const text = await res.text();
    const data = JSON.parse(text);
    const documenti = [...(data.props.documenti?.data || [])];

    const lastLink = data.props.documenti?.links?.at(-1);

    if (lastLink && lastLink.url && !lastLink.active) {
      const nextDocs = await fetchCategorieURL(categoriaId, page + 1);
      documenti.push(...nextDocs);
    }

    console.log(`➡️ Categoria ${categoriaId} - Pagina ${page}: Trovati ${documenti.length} documenti.`);
    return documenti;
  } catch (err) {
    console.error("❌ Errore:", err);
    return [];
  }
}

fetchCategorie();
setInterval(fetchCategorie, CHECK_INTERVAL);
