// Import Gemini SDK from CDN
import { GoogleGenerativeAI } from 'https://esm.run/@google/generative-ai';

let apiKey = localStorage.getItem('gemini_api_key');

// Check if API key exists on load
window.addEventListener('DOMContentLoaded', () => {
    if (apiKey) {
        document.getElementById('apiKeySection').style.display = 'none';
        document.getElementById('formSection').style.display = 'block';
        document.getElementById('apiKeyStatus').textContent = '✓ APIキーが保存されています';
        document.getElementById('apiKeyStatus').style.color = 'var(--secondary)';
    }
});

window.saveApiKey = function () {
    const input = document.getElementById('apiKeyInput');
    apiKey = input.value.trim();

    if (!apiKey) {
        alert('APIキーを入力してください');
        return;
    }

    localStorage.setItem('gemini_api_key', apiKey);
    document.getElementById('apiKeySection').style.display = 'none';
    document.getElementById('formSection').style.display = 'block';
    document.getElementById('apiKeyStatus').textContent = '✓ APIキーが保存されました';
    document.getElementById('apiKeyStatus').style.color = 'var(--secondary)';
};

// PubMed Search Functions
async function searchPubMed(query, retmax = 20) {
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${retmax}&retmode=json`;
    const res = await fetch(url);
    const data = await res.json();
    return data.esearchresult?.idlist || [];
}

async function fetchPubMedDetails(pmids) {
    if (!pmids.length) return [];

    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmids.join(',')}&retmode=xml`;
    const res = await fetch(url);
    const text = await res.text();

    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'text/xml');
    const articles = xml.querySelectorAll('PubmedArticle');

    return Array.from(articles).map(article => {
        try {
            const pmid = article.querySelector('PMID')?.textContent || '';
            const title = article.querySelector('ArticleTitle')?.textContent || '';
            const abstractTexts = article.querySelectorAll('AbstractText');
            const abstract = Array.from(abstractTexts).map(t => t.textContent).join(' ') || 'No abstract available';
            const journal = article.querySelector('Journal Title')?.textContent || '';
            const year = article.querySelector('PubDate Year')?.textContent || 'N/A';

            return { pmid, title, abstract, journal, year };
        } catch (e) {
            return null;
        }
    }).filter(a => a !== null);
}

// Form submission handler
document.getElementById('cattoForm').addEventListener('submit', async function (e) {
    e.preventDefault();

    if (!apiKey) {
        alert('APIキーを設定してください');
        return;
    }

    const btn = document.getElementById('analyzeBtn');
    const btnText = document.getElementById('btnText');
    const spinner = document.getElementById('spinner');
    const results = document.getElementById('results');

    // Show loading state
    btnText.textContent = 'Analyzing...';
    spinner.style.display = 'inline-block';
    btn.disabled = true;
    results.style.display = 'none';

    try {
        // Collect form data
        const formData = {
            submitter_email: document.getElementById('submitter_email').value,
            main_event_1line: document.getElementById('main_event_1line').value,
            condition_event: document.getElementById('condition_event').value,
            anatomy: document.getElementById('anatomy').value,
            trigger_exposure: document.getElementById('trigger_exposure').value,
            timing: document.getElementById('timing').value,
            host_factors: document.getElementById('host_factors').value,
            key_findings: document.getElementById('key_findings').value,
            management_outcome: document.getElementById('management_outcome').value,
            novelty_differences: document.getElementById('novelty_differences').value
        };

        // Initialize Gemini
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

        // Step 1-3: Reconstruction and Query Generation
        const prePrompt = `
You are an expert Anesthesiologist and Researcher.
Perform the following 3 STEPS based on the input Case Report data.
Output strictly in JSON format.

INPUT DATA:
${JSON.stringify(formData, null, 2)}

STEP 1: CATTO Reconstruction
Reconstruct the case event into a standardized definition.

STEP 2: Search Core Definition
Define the "Search Core" for PubMed.

STEP 3: PubMed Query Generation
Generate a 'broad' and 'narrow' PubMed search query.
Provide 'query_term_mapping' to show where terms come from.

OUTPUT JSON FORMAT:
{
  "reconstructed_catto": {
    "condition_event": "...",
    "anatomy": "...",
    "trigger_exposure": "...",
    "timing": "...",
    "host_factors": "...",
    "key_findings": "...",
    "management_outcome": "..."
  },
  "search_core": {
    "mandatory": "...",
    "structural": "...",
    "contextual": "...",
    "modifier": "..."
  },
  "pubmed_query": {
    "broad": "...",
    "narrow": "...",
    "query_term_mapping": [
      { "term": "...", "from": "Condition/Event" }
    ]
  }
}
`;

        console.log('Step 1-3: Generating queries...');
        const preResult = await model.generateContent(prePrompt);
        const preText = preResult.response.text();
        const preJson = JSON.parse(preText.replace(/```json/g, '').replace(/```/g, '').trim());

        // Execute PubMed Search
        console.log('Searching PubMed...');
        let pmids = await searchPubMed(preJson.pubmed_query.narrow, 20);
        if (pmids.length === 0) {
            console.log('Narrow search yielded 0 results, trying broad...');
            pmids = await searchPubMed(preJson.pubmed_query.broad, 20);
        }
        const papers = await fetchPubMedDetails(pmids);
        console.log(`Found ${papers.length} papers`);

        // Step 4-6: Evaluation
        const papersText = papers.map((p, i) =>
            `[${i + 1}] PMID:${p.pmid} Title: ${p.title} Abstract: ${p.abstract}`
        ).join('\n\n');

        const evalPrompt = `
You are an expert Anesthesiologist.
Perform STEPS 4, 5, 6 based on the Search Core and Retrieved Papers.
Output strictly in JSON format.

SEARCH CORE:
${JSON.stringify(preJson.search_core, null, 2)}

RETRIEVED PAPERS (Top 20):
${papersText}

STEP 4: CATTO Level Evaluation
STEP 5: Novelty Score Calculation (0-100)
STEP 6: Quick Literature Check

OUTPUT JSON FORMAT:
{
  "max_level_found": 1-4,
  "novelty_score": 0-100,
  "judgement": "High" | "Moderate" | "Low",
  "reasoning": "...",
  "quick_lit_check": [
    {
      "pmid": "...",
      "title": "...",
      "matched_elements": "...",
      "unmatched_elements": "...",
      "difference": "..."
    }
  ],
  "representative_citations": [
      { "pmid": "...", "title": "...", "year": "..." }
  ]
}
`;

        console.log('Step 4-6: Evaluating novelty...');
        const evalResult = await model.generateContent(evalPrompt);
        const evalText = evalResult.response.text();
        const evalJson = JSON.parse(evalText.replace(/```json/g, '').replace(/```/g, '').trim());

        // Combine results
        const finalResult = { ...preJson, ...evalJson };

        // Display results
        displayResults(finalResult);

    } catch (error) {
        console.error('Analysis Error:', error);
        alert('エラーが発生しました: ' + error.message);
    } finally {
        btnText.textContent = 'Analyze & Send Report';
        spinner.style.display = 'none';
        btn.disabled = false;
    }
});

function displayResults(result) {
    const results = document.getElementById('results');

    document.getElementById('scoreValue').textContent = result.novelty_score;
    document.getElementById('judgementBadge').textContent = result.judgement + ' Priority';

    const badge = document.getElementById('judgementBadge');
    if (result.judgement === 'High') {
        badge.style.background = 'rgba(6, 182, 212, 0.2)';
        badge.style.color = 'var(--secondary)';
    } else if (result.judgement === 'Moderate') {
        badge.style.background = 'rgba(251, 191, 36, 0.2)';
        badge.style.color = '#fbbf24';
    } else {
        badge.style.background = 'rgba(239, 68, 68, 0.2)';
        badge.style.color = '#f87171';
    }

    document.getElementById('reconstructedCatto').textContent = JSON.stringify(result.reconstructed_catto, null, 2);
    document.getElementById('searchCore').textContent = JSON.stringify(result.search_core, null, 2);

    let litCheckHtml = '<h3>Quick Literature Check</h3><ul style="list-style: none; padding: 0;">';
    if (result.quick_lit_check && result.quick_lit_check.length > 0) {
        result.quick_lit_check.forEach(cite => {
            litCheckHtml += `
                <li style="margin-bottom: 0.75rem; padding: 0.75rem; background: rgba(0,0,0,0.2); border-radius: 8px;">
                    <div style="font-weight: bold;">${cite.title} (PMID: ${cite.pmid})</div>
                    <div style="font-size: 0.9rem; margin-top: 0.5rem;">
                       <strong>Matched:</strong> ${cite.matched_elements}<br/>
                       <strong>Unmatched:</strong> ${cite.unmatched_elements}<br/>
                       <strong>Difference:</strong> ${cite.difference}
                    </div>
                </li>
            `;
        });
    } else {
        litCheckHtml += '<li>No specific papers listed.</li>';
    }
    litCheckHtml += '</ul>';

    document.getElementById('resultContent').innerHTML = `
        <div style="margin-bottom: 1.5rem;">
            <h3>Reasoning</h3>
            <p>${result.reasoning}</p>
        </div>
        ${litCheckHtml}
    `;

    results.style.display = 'block';
    results.scrollIntoView({ behavior: 'smooth' });
}
