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
const MIN_DATASET_RATIO = 0.8;
const FETCH_RETRIES = 3;
const RETRY_DELAY_MS = 1200;

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const sortedKeys = Object.keys(value).sort();
  return `{${sortedKeys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function getDocumentUniqueId(doc) {
  const directId = doc?.id;
  if (directId !== undefined && directId !== null && String(directId).trim() !== "") {
    return `doc-id:${String(directId).trim()}`;
  }

  const nestedDocId = doc?.documento?.id;
  if (nestedDocId !== undefined && nestedDocId !== null && String(nestedDocId).trim() !== "") {
    return `nested-doc-id:${String(nestedDocId).trim()}`;
  }

  const documentUrl = doc?.documento?.url;
  if (documentUrl && String(documentUrl).trim() !== "") {
    return `url:${String(documentUrl).trim()}`;
  }

  const fileName = doc?.documento?.nome_file_origine;
  const categoryId = doc?.categoria?.id;
  if (fileName && categoryId !== undefined && categoryId !== null) {
    return `file-category:${String(categoryId)}:${String(fileName).trim().toLowerCase()}`;
  }

  return `payload-hash:${stableStringify(doc)}`;
}

function normalizeDocs(docs) {
  const seenIds = new Set();
  const normalized = [];

  for (const doc of docs) {
    const uniqueId = getDocumentUniqueId(doc);
    if (seenIds.has(uniqueId)) {
      continue;
    }

    seenIds.add(uniqueId);
    normalized.push({
      ...doc,
      _uniqueId: uniqueId,
    });
  }

  return normalized;
}

function getComparablePayload(doc) {
  const { _uniqueId, ...rest } = doc;
  return stableStringify(rest);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(url, contextLabel) {
  let lastError;

  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const text = await res.text();
      return JSON.parse(text);
    } catch (err) {
      lastError = err;
      if (attempt < FETCH_RETRIES) {
        console.warn(
          `⚠️ ${contextLabel}: tentativo ${attempt}/${FETCH_RETRIES} fallito (${err.message}). Riprovo...`
        );
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  throw new Error(
    `${contextLabel}: fallito dopo ${FETCH_RETRIES} tentativi (${lastError?.message || "errore sconosciuto"})`
  );
}

async function fetchCategorie() {
  try {
    const categoriesUrl = `https://web.spaggiari.eu/sdg2/Trasparenza/${CODICE_MECCANOGRAFICO}?idCategoria=0`;
    const data = await fetchJsonWithRetry(categoriesUrl, "Fetch categorie");

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
    const allIds = [...new Set(collectIds(data.props.categorie))];
    console.log(`➡️ Trovate ${allIds.length} categorie.`);

    const settled = await Promise.allSettled(
      allIds.map(async (id) => fetchCategorieURL(id))
    );

    const failedCategoryIds = [];
    const resultsArray = [];

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status === "fulfilled") {
        resultsArray.push(result.value);
      } else {
        failedCategoryIds.push(allIds[i]);
      }
    }

    if (failedCategoryIds.length > 0) {
      console.error(
        `❌ Run incompleta: ${failedCategoryIds.length}/${allIds.length} categorie non scaricate. Snapshot NON aggiornato.`
      );
      console.error(`Categorie fallite: ${failedCategoryIds.join(", ")}`);
      return;
    }

    const flatResult = resultsArray.flat();

    if (fs.existsSync(SNAPSHOT_FILE)) {
      const previousDocs = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
      const minExpectedDocs = Math.floor(previousDocs.length * MIN_DATASET_RATIO);

      if (flatResult.length < minExpectedDocs) {
        console.error(
          `❌ Run sospetta: documenti correnti ${flatResult.length}, attesi almeno ${minExpectedDocs} (${Math.round(
            MIN_DATASET_RATIO * 100
          )}% di ${previousDocs.length}). Snapshot NON aggiornato.`
        );
        return;
      }
    }

    await checkForChanges(flatResult);

    fs.writeFileSync(new Date().toDateString() + "_data_flat.json", JSON.stringify(flatResult, null, 2));
    console.log(`✅ Salvati ${flatResult.length} documenti totali`);
  } catch (err) {
    console.error("❌ Errore:", err);
  }
}

async function checkForChanges(currentDocs) {
  const normalizedCurrentDocs = normalizeDocs(currentDocs);
  const isFirstRun = !fs.existsSync(SNAPSHOT_FILE);

  if (isFirstRun) {
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(normalizedCurrentDocs, null, 2));
    console.log("🆕 Prima esecuzione: snapshot creato, nessun webhook inviato.");
    return;
  }

  const previousDocs = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));

  const prevMap = new Map(
    previousDocs.map((doc) => {
      const uniqueId = doc?._uniqueId || getDocumentUniqueId(doc);
      return [uniqueId, getComparablePayload(doc)];
    })
  );

  for (const doc of normalizedCurrentDocs) {
    const uniqueId = doc._uniqueId;
    const currValue = getComparablePayload(doc);

    if (!prevMap.has(uniqueId)) {
      await sendDiscordAlert(
        `🆕 Nuovo documento\n` +
        `ID: ${uniqueId}\n` +
        `File: ${doc.documento?.nome_file_origine || "N/D"}\n` +
        `Categoria: ${doc.categoria?.descrizione_class || "N/D"}\n` +
        `${doc.documento?.url || ""}`
      );
    } else if (prevMap.get(uniqueId) !== currValue) {
      await sendDiscordAlert(
        `⚠️ Documento modificato\n` +
        `ID: ${uniqueId}\n` +
        `File: ${doc.documento?.nome_file_origine || "N/D"}\n` +
        `Categoria: ${doc.categoria?.descrizione_class || "N/D"}\n` +
        `${doc.documento?.url || ""}`
      );
    }
  }

  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(normalizedCurrentDocs, null, 2));
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
    const data = await fetchJsonWithRetry(
      `https://web.spaggiari.eu/sdg2/Trasparenza/${CODICE_MECCANOGRAFICO}?idCategoria=${categoriaId}&page=${page}`,
      `Fetch categoria ${categoriaId} pagina ${page}`
    );
    const documenti = [...(data.props.documenti?.data || [])];

    const lastLink = data.props.documenti?.links?.at(-1);

    if (lastLink && lastLink.url && !lastLink.active) {
      const nextDocs = await fetchCategorieURL(categoriaId, page + 1);
      documenti.push(...nextDocs);
    }

    console.log(`➡️ Categoria ${categoriaId} - Pagina ${page}: Trovati ${documenti.length} documenti.`);
    return documenti;
  } catch (err) {
    throw err;
  }
}

async function tick() {
  try {
    await fetchCategorie();
  } catch (error) {
    console.error("❌ Controllo Amministrazione Trasparente fallito:", error);
  } finally {
    setTimeout(() => void tick(), CHECK_INTERVAL);
  }
}

void tick();
