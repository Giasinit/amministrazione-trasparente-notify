const fs = require("fs");

// Headers richiesti da Spaggiari per ottenere JSON (non HTML)
const headers = {
  "x-inertia": "true",
  "x-inertia-version": "0c651f0cc4f691db3f4418d733314948",
};

async function fetchCategorie() {
  try {
    const res = await fetch("https://web.spaggiari.eu/sdg2/Trasparenza/pdit0009?idCategoria=0", {
      headers,
    });

    const text = await res.text();
    const data = JSON.parse(text);

    // Funzione ricorsiva per estrarre tutti gli ID, anche dalle sub_categorie
    function collectIds(categorie, acc = []) {
      for (const cat of categorie) {
        acc.push(cat.id);
        if (Array.isArray(cat.sub_categorie) && cat.sub_categorie.length > 0) {
          collectIds(cat.sub_categorie, acc);
        }
      }
      return acc;
    }

    // Ottieni tutti gli ID (già fatto)
    const allIds = collectIds(data.props.categorie);
    const result = {};

    // Promise.all per eseguire tutte le fetch in parallelo
    console.log(`🚀 Fetching documents for ${allIds.length} categorie...`);

    const resultsArray = await Promise.all(
    allIds.map(async (id) => {
        console.log(`🔍 Fetching documents for categoria ID: ${id}`);
        const docs = await fetchCategorieURL(id);
        return { id, docs };
    })
    );

    // Ricostruisci l’oggetto "result"
    for (const { id, docs } of resultsArray) {
    result[id] = docs;
    }

    // Scrive il file dettagliato
    fs.writeFileSync(new Date().toDateString()+"_data.json", JSON.stringify(result, null, 2));

    // Flat di tutti i documenti in un unico array
    const flatResult = resultsArray.flatMap((r) => r.docs);
    fs.writeFileSync(new Date().toDateString()+"_data_flat.json", JSON.stringify(flatResult, null, 2));

    console.log(`✅ Salvati ${flatResult.length} documenti totali`);


  } catch (err) {
    console.error("❌ Errore:", err);
  }
}

fetchCategorie();


async function fetchCategorieURL(categoriaId, page = 1) {
  try {
    const res = await fetch(
      `https://web.spaggiari.eu/sdg2/Trasparenza/pdit0009?idCategoria=${categoriaId}&page=${page}`,
      { headers }
    );

    const text = await res.text();
    const data = JSON.parse(text);
    const documenti = [...(data.props.documenti?.data || [])];

    // prendi l’ultimo link
    const lastLink = data.props.documenti?.links?.at(-1);

    // se c’è una pagina successiva, continua ricorsivamente
    if (lastLink && lastLink.url && !lastLink.active) {
      const nextDocs = await fetchCategorieURL(categoriaId, page + 1);
      documenti.push(...nextDocs);
    }

    console.log(`   📄 Trovati ${documenti.length} documenti nella categoria ID: ${categoriaId} (pagina ${page})`);
    return documenti;
  } catch (err) {
    console.error("❌ Errore:", err);
    return [];
  }
}

