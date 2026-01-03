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

// Helper to extract JSON from markdown text
function extractJson(text) {
    try {
        // Find JSON block
        const startIndex = text.indexOf('{');
        const endIndex = text.lastIndexOf('}');
        if (startIndex === -1 || endIndex === -1) {
            throw new Error('No JSON object found in response');
        }
        const jsonStr = text.substring(startIndex, endIndex + 1);
        return JSON.parse(jsonStr);
    } catch (e) {
        console.error('JSON Parse Failed:', e);
        console.error('Raw Text:', text);
        throw new Error('AIの応答を解析できませんでした。もう一度お試しください。');
    }
}

// PubMed Search Functions
async function searchPubMed(query, retmax = 100) {
    const toolName = 'CaseReport-CATTO';
    const email = document.getElementById('submitter_email')?.value || 'user@example.com';
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${retmax}&retmode=json&sort=relevance&tool=${toolName}&email=${email}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.esearchresult?.idlist || [];
}

async function fetchSimilarPmidsByElink(seedPmids, retmaxPerSeed = 10) {
    if (!seedPmids || seedPmids.length === 0) return [];

    // Take top 5 seeds to avoid URL length issues
    const seeds = seedPmids.slice(0, 5);
    const toolName = 'CaseReport-CATTO';
    const email = document.getElementById('submitter_email')?.value || 'user@example.com';

    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=pubmed&db=pubmed&linkname=pubmed_pubmed&cmd=neighbor_score&id=${seeds.join(',')}&retmode=json&tool=${toolName}&email=${email}`;

    try {
        const res = await fetch(url);
        const data = await res.json();

        // Parse linksets
        let similarPmids = [];
        if (data.linksets) {
            for (const linkset of data.linksets) {
                if (linkset.linksetdbs) {
                    for (const db of linkset.linksetdbs) {
                        if (db.linkname === 'pubmed_pubmed' && db.links) {
                            // Extract IDs, limiting per seed
                            const ids = db.links.slice(0, retmaxPerSeed).map(l => l.id);
                            similarPmids.push(...ids);
                        }
                    }
                }
            }
        }

        // Remove duplicates and original seeds
        const seedSet = new Set(seeds);
        const uniqueSimilar = [...new Set(similarPmids)].filter(id => !seedSet.has(id));
        return uniqueSimilar;

    } catch (e) {
        console.error('ELink fetch failed:', e);
        return [];
    }
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

            // Extract DOI
            let doi = '';
            const articleIds = article.querySelectorAll('ArticleId');
            for (const id of articleIds) {
                if (id.getAttribute('IdType') === 'doi') {
                    doi = id.textContent;
                    break;
                }
            }

            return { pmid, title, abstract, journal, year, doi };
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
        const preJson = extractJson(preText);

        // Execute PubMed Search
        console.log('Searching PubMed...');
        let pmids = await searchPubMed(preJson.pubmed_query.narrow, 20);
        if (pmids.length === 0) {
            console.log('Narrow search yielded 0 results, trying broad...');
            pmids = await searchPubMed(preJson.pubmed_query.broad, 20);
        }
        const papers = await fetchPubMedDetails(pmids);
        console.log(`Found ${papers.length} papers`);

        // Step 4-6: Evaluation with Structural Hallucination Prevention
        // 1. Prepare Papers for LLM (Hide PMIDs/Titles, show only Content and assigned ID)
        const papersForLLM = papers.map((p, i) =>
            `[P${i + 1}] Abstract: ${p.abstract}`
        ).join('\n\n');

        const evalPrompt = `
You are an expert Anesthesiologist.
Perform STEPS 4, 5, 6 based on the Search Core and Retrieved Papers.
The papers are provided with IDs [P1], [P2], etc.
You must refer to papers ONLY by their ID (e.g., [P1]).
Output strictly in JSON format.

SEARCH CORE:
${JSON.stringify(preJson.search_core, null, 2)}

RETRIEVED PAPERS (Top 20):
${papersForLLM}

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
Select up to 20 relevant papers that support your evaluation.
Return "paper_evaluations" for each selected paper.

OUTPUT JSON FORMAT:
{
  "max_level_found": 0-4,
  "judgement": "High" | "Moderate" | "Low",
  "selected_paper_ids": [1, 2, 5], // List of IDs of relevant papers (integers)
  "paper_evaluations": [
    {
      "paper_id": 1, // Integer ID corresponding to [P1]
      "match_level": 1-4,
      "matched_elements": "...",
      "unmatched_elements": "...",
      "difference": "..."
    }
  ],
  "reasoning_with_ids": "Explain why this level was chosen. WHEN CITING PAPERS, YOU MUST USE THE FORMAT [P1], [P2], etc. DO NOT WRITE TITLES OR PMIDS."
}
`;

        console.log('Step 4-6: Evaluating novelty (ID-based Structured Analysis)...');

        // Use JSON Schema if supported, otherwise rely on prompt and extractJson
        const evalResult = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: evalPrompt }] }],
            generationConfig: {
                responseMimeType: "application/json"
            }
        });

        const evalText = evalResult.response.text();
        const evalJson = extractJson(evalText);

        // --- JavaScript Reconstruction (The Source of Truth) ---
        console.log('Reconstructing results from trusted data...');

        // 1. Reconstruct Quick Literature Check
        const validatedLitCheck = [];
        if (evalJson.selected_paper_ids && Array.isArray(evalJson.selected_paper_ids)) {
            // Remove duplicates
            const uniqueIds = [...new Set(evalJson.selected_paper_ids)];

            for (const pid of uniqueIds) {
                // Validate ID range
                const index = pid - 1; // [P1] -> index 0
                if (index >= 0 && index < papers.length) {
                    const originalPaper = papers[index];
                    const evaluation = evalJson.paper_evaluations?.find(e => e.paper_id === pid);

                    validatedLitCheck.push({
                        pmid: originalPaper.pmid, // Source of Truth
                        doi: originalPaper.doi || '', // Source of Truth
                        title: originalPaper.title, // Source of Truth
                        url: `https://pubmed.ncbi.nlm.nih.gov/${originalPaper.pmid}/`,
                        matched_elements: evaluation?.matched_elements || 'N/A',
                        unmatched_elements: evaluation?.unmatched_elements || 'N/A',
                        difference: evaluation?.difference || 'N/A'
                    });
                }
            }
        }

        // 2. Reconstruct Reasoning (Replace [P#] with "Title (PMID: ...)")
        let finalReasoning = evalJson.reasoning_with_ids || '';
        if (finalReasoning) {
            // Replace [P#] with citation
            finalReasoning = finalReasoning.replace(/\[P(\d+)\]/g, (match, idStr) => {
                const index = parseInt(idStr) - 1;
                if (index >= 0 && index < papers.length) {
                    const p = papers[index];
                    return `${p.title} (PMID: ${p.pmid})`;
                }
                return match; // Keep as is if invalid ID
            });
        }

        // Final Result Construction
        const finalEvalJson = {
            max_level_found: evalJson.max_level_found,
            judgement: evalJson.judgement,
            reasoning: finalReasoning,
            quick_lit_check: validatedLitCheck
        };

        // Deterministic Score Calculation
        // Level 4 (Many reports) -> <= 20%
        // Level 3 (Some reports) -> 30-50%
        // Level 2 (Few reports) -> 60-80%
        // Level 1/0 (Novel) -> >= 85%
        let calcScore = 0;
        const maxLevel = finalEvalJson.max_level_found;

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
            ...finalEvalJson,
            novelty_score: calcScore
        };

        // Display results
        displayResults(finalResult, formData);

    } catch (error) {
        console.error('Analysis Error:', error);
        alert('エラーが発生しました: ' + error.message);
    } finally {
        btnText.textContent = 'Analyze & Send Report';
        spinner.style.display = 'none';
        btn.disabled = false;
    }
});

function displayResults(result, formData) {
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
    let litCheckEmailText = '';
    if (result.quick_lit_check && result.quick_lit_check.length > 0) {
        result.quick_lit_check.forEach((cite, idx) => {
            const doiDisplay = cite.doi ? ` | DOI: ${cite.doi}` : '';
            litCheckHtml += `
                <li style="margin-bottom: 0.75rem; padding: 0.75rem; background: rgba(0,0,0,0.2); border-radius: 8px;">
                    <div style="font-weight: bold;">
                        <a href="${cite.url}" target="_blank" style="color: var(--secondary); text-decoration: none;">${cite.title}</a>
                    </div>
                    <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 0.25rem;">
                       PMID: ${cite.pmid}${doiDisplay}
                    </div>
                    <div style="font-size: 0.9rem; margin-top: 0.5rem;">
                       <strong>Matched:</strong> ${cite.matched_elements}<br/>
                       <strong>Unmatched:</strong> ${cite.unmatched_elements}<br/>
                       <strong>Difference:</strong> ${cite.difference}
                    </div>
                </li>
            `;
            litCheckEmailText += `
[${idx + 1}] ${cite.title}
    PMID: ${cite.pmid}${cite.doi ? `\n    DOI: ${cite.doi}` : ''}
    Matched Elements: ${cite.matched_elements}
    Unmatched Elements: ${cite.unmatched_elements}
    Difference: ${cite.difference}

`;
        });
    } else {
        litCheckHtml += '<li>No specific papers listed.</li>';
        litCheckEmailText = 'No specific papers found.\n';
    }
    litCheckHtml += '</ul>';

    // Create comprehensive email body
    const emailSubject = `症例報告スクリーニング結果: ${result.judgement} Priority (Novelty ${result.novelty_score}%)`;
    const emailBody = `
========================================
症例報告分析結果 / Case Report Analysis
========================================

【判定 / Judgement】
Priority: ${result.judgement}
Novelty Score: ${result.novelty_score}% (CATTO Level ${result.max_level_found} に基づく)

【入力されたCATTOデータ】
━━━━━━━━━━━━━━━━━━━━━━
A. Main Event (主事象):
${formData.main_event_1line}

B. Condition/Event (状態・イベント):
${formData.condition_event}

C. Anatomy (解剖学的部位):
${formData.anatomy}

D. Trigger/Exposure (トリガー):
${formData.trigger_exposure}

E. Timing (タイミング):
${formData.timing}

F. Host Factors (宿主因子):
${formData.host_factors || 'N/A'}

G. Key Findings (主要所見):
${formData.key_findings || 'N/A'}

H. Management/Outcome (管理・転帰):
${formData.management_outcome || 'N/A'}

I. Novelty/Differences (新規性):
${formData.novelty_differences}

【理由 / Reasoning】
━━━━━━━━━━━━━━━━━━━━━━
${result.reasoning}

※ 上記の理由を日本語に翻訳してください。

【文献チェック / Quick Literature Check】
━━━━━━━━━━━━━━━━━━━━━━
${litCheckEmailText}

【検索コア / Search Core】
━━━━━━━━━━━━━━━━━━━━━━
${JSON.stringify(result.search_core, null, 2)}

━━━━━━━━━━━━━━━━━━━━━━
Generated by CaseReport-CATTO
    `.trim();

    const mailtoLink = `mailto:${formData.submitter_email}?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(emailBody)}`;

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
