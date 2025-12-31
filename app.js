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
Evaluate EACH paper's match level (1-4).
- Level 1: Condition/Event matches
- Level 2: + Anatomy matches
- Level 3: + Trigger/Exposure matches
- Level 4: + Timing matches

STEP 5: Novelty Assessment
Determine the "max_level_found" (integer 0-4) based on the highest match found in literature.
(0 means no matches found).

STEP 6: Quick Literature Check

OUTPUT JSON FORMAT:
{
  "max_level_found": 0-4,
  "judgement": "High" | "Moderate" | "Low",
  "reasoning": "Explain why this level was chosen based on the papers...",
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

        // Deterministic Score Calculation
        // Level 4 (Many reports) -> <= 20%
        // Level 3 (Some reports) -> 30-50%
        // Level 2 (Few reports) -> 60-80%
        // Level 1/0 (Novel) -> >= 85%
        let calcScore = 0;
        const maxLevel = evalJson.max_level_found;

        if (maxLevel >= 4) {
            calcScore = 15;
        } else if (maxLevel === 3) {
            calcScore = 40;
        } else if (maxLevel === 2) {
            calcScore = 70;
        } else { // maxLevel is 0 or 1
            calcScore = 90;
        }

        // Force consistency
        const finalResult = {
            ...preJson,
            ...evalJson,
            novelty_score: calcScore
        };

        // Display results
        displayResults(finalResult, formData.submitter_email);

    } catch (error) {
        console.error('Analysis Error:', error);
        alert('エラーが発生しました: ' + error.message);
    } finally {
        btnText.textContent = 'Analyze & Send Report';
        spinner.style.display = 'none';
        btn.disabled = false;
    }
});

function displayResults(result, email) {
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

    // Create Email Body
    const emailSubject = `Case Report Screening Result: ${result.judgement} Priority`;
    const emailBody = `
Case Report Analysis Results
----------------------------
Judgement: ${result.judgement} Priority
Novelty Score: ${result.novelty_score}% (Derived from Cat. Level ${result.max_level_found})

Reasoning:
${result.reasoning}

Search Core:
${JSON.stringify(result.search_core, null, 2)}
    `.trim();

    const mailtoLink = `mailto:${email}?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(emailBody)}`;

    document.getElementById('resultContent').innerHTML = `
        <div style="margin-bottom: 1.5rem;">
            <h3>Reasoning</h3>
            <p>${result.reasoning}</p>
            <p style="font-size: 0.9rem; color: var(--text-muted); margin-top: 5px;">
               <em>(Score calculated based on Max Match Level: ${result.max_level_found})</em>
            </p>
        </div>
        ${litCheckHtml}
        
        <div style="margin-top: 2rem; text-align: center; border-top: 1px solid var(--border); padding-top: 1.5rem;">
            <p style="margin-bottom: 1rem;"><strong>Email Report</strong></p>
            <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1rem;">
               GitHub Pages (静的サイト) からは自動送信できません。<br>
               以下のボタンを押してメールソフトを起動してください。
            </p>
            <a href="${mailtoLink}" class="btn btn-primary" style="text-decoration: none;">
               📩 Open Email Draft
            </a>
        </div>
    `;

    results.style.display = 'block';
    results.scrollIntoView({ behavior: 'smooth' });
}
