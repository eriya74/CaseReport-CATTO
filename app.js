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
        loadFormData();
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
    loadFormData();
};

// Form Persistence Logic
function loadFormData() {
    const inputs = document.querySelectorAll('#cattoForm input, #cattoForm textarea');
    inputs.forEach(input => {
        if (input.id) {
            const savedValue = localStorage.getItem('catto_form_' + input.id);
            if (savedValue !== null) {
                input.value = savedValue;
            }
        }
    });
}

function saveFormData() {
    const inputs = document.querySelectorAll('#cattoForm input, #cattoForm textarea');
    inputs.forEach(input => {
        if (input.id) {
            localStorage.setItem('catto_form_' + input.id, input.value);
        }
    });
}

// Auto-save on input
document.getElementById('cattoForm').addEventListener('input', saveFormData);

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

            const titleNode = article.querySelector('ArticleTitle');
            // Sometimes title is in BookDocument, but here mostly PubmedArticle
            const title = titleNode ? titleNode.textContent : '';

            const abstractTexts = article.querySelectorAll('AbstractText');
            const abstract = Array.from(abstractTexts).map(t => t.textContent).join(' ') || 'No abstract available';

            // Journal Title
            const journalNode = article.querySelector('Journal > Title');
            const journal = journalNode ? journalNode.textContent : (article.querySelector('Journal Title')?.textContent || '');

            // Year: Try PubDate Year, then MedlineDate
            let year = article.querySelector('PubDate > Year')?.textContent;
            if (!year) {
                const medlineDate = article.querySelector('PubDate > MedlineDate')?.textContent;
                if (medlineDate) {
                    const match = medlineDate.match(/\d{4}/);
                    year = match ? match[0] : 'N/A';
                } else {
                    year = 'N/A';
                }
            }

            // Extract DOI
            let doi = '';
            const articleIds = article.querySelectorAll('ArticleId');
            for (const id of articleIds) {
                if (id.getAttribute('IdType') === 'doi') {
                    doi = id.textContent;
                    break;
                }
            }

            // Build URL
            const pubmedUrl = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;

            return { pmid, title, abstract, journal, year, doi, url: pubmedUrl };
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
- Use COMPULSORY PubMed syntax tags: [mh] for MeSH Terms, [tiab] for Title/Abstract.
- Use boolean operators AND, OR, NOT.
- 'narrow': Specific combination of Condition, Anatomy, and Context.
- 'broad': Broader concepts if narrow fails.

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

        // Execute PubMed Search (Enhanced Flow)
        console.log('Searching PubMed (Enhanced)...');

        // 1. Narrow Search (target 100)
        let pmids = await searchPubMed(preJson.pubmed_query.narrow, 100);
        let usedQuery = preJson.pubmed_query.narrow;

        // 2. Broad Search if low results (< 20)
        if (pmids.length < 20) {
            console.log('Narrow search yielded few results, trying broad...');
            const broadPmids = await searchPubMed(preJson.pubmed_query.broad, 200);

            // Union and preserve order (relevance)
            const pmidSet = new Set(pmids);
            for (const pid of broadPmids) {
                if (!pmidSet.has(pid)) {
                    pmids.push(pid);
                    pmidSet.add(pid);
                }
            }
        }

        // 3. ELink Expansion (Similar Articles)
        console.log('Fetching similar articles via ELink...');
        const similarPmids = await fetchSimilarPmidsByElink(pmids, 10);

        // Union similar PMIDs
        const pmidSet = new Set(pmids);
        for (const pid of similarPmids) {
            if (!pmidSet.has(pid)) {
                pmids.push(pid);
            }
        }

        // Cap result size for LLM analysis (e.g., top 80)
        const topPmids = pmids.slice(0, 80);
        console.log(`Total candidates after expansion: ${pmids.length}, using top ${topPmids.length}`);

        const papers = await fetchPubMedDetails(topPmids);
        console.log(`Successfully fetched details for ${papers.length} papers`);

        // Check if papers were found - SHORT CIRCUIT IF EMPTY
        let finalResult;

        if (papers.length === 0) {
            console.warn('No papers found matching the query. Skipping LLM evaluation to avoid hallucination.');
            finalResult = {
                ...preJson,
                max_level_found: 0,
                judgement: 'High',
                reasoning: 'Detailed analysis could not be performed because no relevant papers were found in PubMed matching the generated search queries. This suggests the case is likely novel (High Priority) or the search terms were too specific.',
                quick_lit_check: [],
                novelty_score: 90
            };
        } else {
            // Step 4-6: Evaluation with Structural Hallucination Prevention
            // 1. Prepare Papers for LLM
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

RETRIEVED PAPERS (Top candidates):
${papersForLLM}

STEP 4: CATTO Level Evaluation
Evaluate EACH paper's match level (1-4).
- Level 1: Condition/Event matches: The abstract describes the same condition or event.
- Level 2: + Anatomy matches: The anatomy is also consistent.
- Level 3: + Trigger/Exposure matches: The trigger or context is also consistent.
- Level 4: + Timing matches: The timing (intro-op/post-op phase) is also consistent.

STEP 5: Novelty Assessment
Determine the "max_level_found" (integer 0-4) based on the highest match found in literature.
(0 means no matches found).

STEP 6: Quick Literature Check
Select relevant papers that support your evaluation (e.g. highest matches or close calls).
Return "paper_evaluations" for each selected paper.

IMPORTANT: You MUST provide "evidence_quotes" for EACH paper evaluation.
- evidence_quotes: An array of 1-2 short phrases DIRECTLY COPIED from the Abstract of the paper.
- Phrases must be 20-120 chars.
- NO paraphrasing. Quotes must potentially match via string "includes()" check.
- If no direct evidence exists, return an empty array [].
- DO NOT assign a high match level (3-4) without finding clear quote evidence. Be conservative.

OUTPUT JSON FORMAT:
{
  "max_level_found": 0-4,
  "judgement": "High" | "Moderate" | "Low",
  "selected_paper_ids": [1, 2, 5],
  "paper_evaluations": [
    {
      "paper_id": 1,
      "match_level": 1-4,
      "matched_elements": "...",
      "unmatched_elements": "...",
      "difference": "...",
      "evidence_quotes": ["...", "..."]
    }
  ],
  "reasoning_with_ids": "Explain why this level was chosen. WHEN CITING PAPERS, YOU MUST USE THE FORMAT [P1], [P2], etc."
}
`;
            console.log('Step 4-6: Evaluating novelty (ID-based Structured Analysis)...');

            const evalResult = await model.generateContent({
                contents: [{ role: "user", parts: [{ text: evalPrompt }] }],
                generationConfig: {
                    responseMimeType: "application/json"
                }
            });

            const evalText = evalResult.response.text();
            const evalJson = extractJson(evalText);

            // --- JavaScript Reconstruction & VERIFICATION (The Source of Truth) ---
            console.log('Reconstructing results from trusted data...');

            const validatedLitCheck = [];
            let verifiedMaxLevel = 0; // Will be recalculated
            let systemNotes = [];

            // 1. Process and Verify each paper
            // Logic: Scan all unique IDs mentioned in selected_paper_ids AND paper_evaluations
            let rawSelectedIds = evalJson.selected_paper_ids || [];
            if (!Array.isArray(rawSelectedIds)) rawSelectedIds = [rawSelectedIds];

            let evals = evalJson.paper_evaluations || [];
            // Merge IDs from evaluations into selection if missing
            evals.forEach(ev => {
                if (ev.paper_id && !rawSelectedIds.includes(ev.paper_id)) {
                    // Optional: deciding whether to include automatic evals not in selection
                    // For now, trust explicit selection or just process what we have.
                    // Let's stick to processing IDs that appear in evaluations relevant to the selection.
                }
            });

            // Normalize IDs to handle various AI outputs
            const extractId = (val) => {
                const s = String(val);
                const match = s.match(/(\d+)/);
                return match ? parseInt(match[1], 10) : null;
            };

            const processedIds = new Set();

            // Filter evaluations to only those that match valid IDs 1..papers.length
            const validEvaluations = evals.map(ev => {
                ev._cleanId = extractId(ev.paper_id);
                return ev;
            }).filter(ev => ev._cleanId !== null && ev._cleanId >= 1 && ev._cleanId <= papers.length);

            // Verify Quotes Logic
            for (const ev of validEvaluations) {
                const pid = ev._cleanId;
                const pIndex = pid - 1;
                const paper = papers[pIndex];
                const abstractLower = (paper.abstract || '').toLowerCase();
                const quotes = ev.evidence_quotes || [];

                let validQuotes = [];
                let matchCount = 0;

                quotes.forEach(q => {
                    const qClean = q.trim().toLowerCase();
                    // Remove quotes if included in string
                    const qRaw = qClean.replace(/^["']|["']$/g, '');
                    if (qRaw.length > 5 && abstractLower.includes(qRaw)) {
                        matchCount++;
                        validQuotes.push(q);
                    }
                });

                let finalLevel = ev.match_level;
                let note = '';

                // Verification Rules
                if (quotes.length === 0) {
                    // 1) No quotes -> Downgrade to 1
                    finalLevel = 1;
                    note = 'No evidence provided';
                } else if (matchCount === 0) {
                    // 2) All quotes invalid -> Hallucination -> Level 0
                    finalLevel = 0;
                    note = 'Hallucinated evidence invalidated';
                } else if (matchCount < quotes.length) {
                    // 3) Partial -> Downgrade by 1 (min 1)
                    finalLevel = Math.max(1, finalLevel - 1);
                    note = 'Partial evidence match';
                } else {
                    // 4) Full match -> Maintain
                }

                // Track Max Level
                if (finalLevel > verifiedMaxLevel) {
                    verifiedMaxLevel = finalLevel;
                }

                // Only add to literature check if level > 0 (valid)
                if (finalLevel > 0) {
                    validatedLitCheck.push({
                        pmid: paper.pmid,
                        doi: paper.doi || '',
                        title: paper.title,
                        url: paper.url,
                        matched_elements: ev.matched_elements || 'N/A',
                        unmatched_elements: ev.unmatched_elements || 'N/A',
                        difference: ev.difference || 'N/A',
                        evidence_quotes: validQuotes, // Only valid ones
                        verification_note: note,
                        verified_level: finalLevel
                    });
                } else {
                    systemNotes.push(`Paper [P${pid}] invalidated: ${note}.`);
                }
            }

            // Sort by level descending
            validatedLitCheck.sort((a, b) => b.verified_level - a.verified_level);

            // 2. Reconstruct Reasoning
            let finalReasoning = evalJson.reasoning_with_ids || evalJson.reasoning || '';
            if (finalReasoning) {
                const replaceCallback = (match, idStr) => {
                    const index = parseInt(idStr, 10) - 1;
                    if (index >= 0 && index < papers.length) {
                        const p = papers[index];
                        return `${p.title} (PMID: ${p.pmid})`;
                    }
                    return `(Citation Error: Paper ID #${idStr} not found)`;
                };
                finalReasoning = finalReasoning.replace(/(\[|\()\s*(?:Paper|P)?\s*(\d+)\s*(\]|\))/gi, (match, open, idStr, close) => replaceCallback(match, idStr));
                finalReasoning = finalReasoning.replace(/\b(?:Paper|P)\s*(\d+)\b/gi, (match, idStr) => replaceCallback(match, idStr));
            }

            // Append System Notes
            if (systemNotes.length > 0) {
                finalReasoning += `\n\n[System Verification Note: ${systemNotes.join(' ')}]`;
            }

            // Recalculate Judgement based on VERIFIED Max Level
            let finalJudgement = 'Low';
            if (verifiedMaxLevel <= 1) finalJudgement = 'High';
            else if (verifiedMaxLevel === 2) finalJudgement = 'Moderate';
            else if (verifiedMaxLevel >= 3) finalJudgement = 'Low';
            // Note: User prompt said 0-1 High, 2 Moderate, 3-4 Low. 
            // My previous logic was: 
            // Level 4 (Many reports) -> <= 20%
            // Level 3 (Some reports) -> 30-50%
            // Level 2 (Few reports) -> 60-80%
            // Level 1/0 (Novel) -> >= 85%
            // I will match the score logic to judgment logic.

            let calcScore = 0;
            if (verifiedMaxLevel >= 4) {
                calcScore = 15;
                finalJudgement = 'Low';
            } else if (verifiedMaxLevel === 3) {
                calcScore = 40;
                finalJudgement = 'Low'; // or Moderate-Low
            } else if (verifiedMaxLevel === 2) {
                calcScore = 70;
                finalJudgement = 'Moderate';
            } else {
                calcScore = 90;
                finalJudgement = 'High';
            }

            finalResult = {
                ...preJson,
                max_level_found: verifiedMaxLevel,
                judgement: finalJudgement,
                reasoning: finalReasoning,
                quick_lit_check: validatedLitCheck,
                novelty_score: calcScore,
                pubmed_query: preJson.pubmed_query // Ensure query is passed
            };
        }

        // Display results
        displayResults(finalResult, formData, papers.length);

    } catch (error) {
        console.error('Analysis Error:', error);
        alert('エラーが発生しました: ' + error.message);
    } finally {
        btnText.textContent = 'Analyze & Send Report';
        spinner.style.display = 'none';
        btn.disabled = false;
    }
});

function displayResults(result, formData, totalPapers = -1) {
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

    let litCheckHtml = '<h3>Quick Literature Check</h3>';

    // Display the Query Used
    const queryDisplay = result.pubmed_query?.narrow || 'N/A';
    litCheckHtml += `
        <div style="margin-bottom: 1rem; padding: 0.75rem; background: rgba(0, 0, 0, 0.3); border-radius: 6px; font-family: monospace; font-size: 0.85rem; border-left: 3px solid var(--secondary);">
            <div style="color: var(--text-muted); margin-bottom: 4px; font-weight: bold;">PubMed Search Query:</div>
            <div style="word-break: break-all;">${queryDisplay}</div>
        </div>
    `;

    litCheckHtml += '<ul style="list-style: none; padding: 0;">';
    let litCheckEmailText = '';

    if (totalPapers === 0) {
        litCheckHtml += `<div style="background: rgba(251, 191, 36, 0.1); border: 1px solid rgba(251, 191, 36, 0.3); padding: 10px; border-radius: 6px; margin-bottom: 15px; font-size: 0.9rem; color: #fbbf24;">
            ⚠️ PubMed query returned 0 results. No literature available for verification.
        </div>`;
    }

    if (result.quick_lit_check && result.quick_lit_check.length > 0) {
        result.quick_lit_check.forEach((cite, idx) => {
            const doiDisplay = cite.doi ? ` | DOI: ${cite.doi}` : '';
            // Format quotes
            let quotesHtml = '';
            let quotesText = '';
            if (cite.evidence_quotes && cite.evidence_quotes.length > 0) {
                quotesHtml = `<div style="margin-top: 0.5rem; font-style: italic; color: #a1a1aa; border-left: 2px solid #52525b; padding-left: 8px;">"${cite.evidence_quotes.join('"<br>"')}"</div>`;
                quotesText = `\n    Evidence: "${cite.evidence_quotes.join('", "')}"`;
            }
            // Format verification note
            const noteHtml = cite.verification_note ? `<span style="font-size: 0.8rem; color: #fbbf24; margin-left: 5px;">(${cite.verification_note})</span>` : '';

            litCheckHtml += `
                <li style="margin-bottom: 0.75rem; padding: 0.75rem; background: rgba(0,0,0,0.2); border-radius: 8px;">
                    <div style="font-weight: bold;">
                        <a href="${cite.url}" target="_blank" style="color: var(--secondary); text-decoration: none;">${cite.title}</a>
                        ${noteHtml}
                    </div>
                    <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 0.25rem;">
                       PMID: ${cite.pmid}${doiDisplay}
                    </div>
                    ${quotesHtml}
                    <div style="font-size: 0.9rem; margin-top: 0.5rem;">
                       <strong>Matched:</strong> ${cite.matched_elements}<br/>
                       <strong>Unmatched:</strong> ${cite.unmatched_elements}<br/>
                       <strong>Difference:</strong> ${cite.difference}
                    </div>
                </li>
            `;
            litCheckEmailText += `
[${idx + 1}] ${cite.title}
    PMID: ${cite.pmid}${cite.doi ? `\n    DOI: ${cite.doi}` : ''}${quotesText}
    Matched Elements: ${cite.matched_elements}
    Unmatched Elements: ${cite.unmatched_elements}
    Difference: ${cite.difference}

`;
        });
    } else {
        litCheckHtml += '<li>No specific papers listed (or all invalidated).</li>';
        litCheckEmailText = 'No specific papers found.\n';
    }
    litCheckHtml += '</ul>';

    const emailSubject = `症例報告スクリーニング結果: ${result.judgement} Priority (Novelty ${result.novelty_score}%)`;
    const emailBody = `
========================================
症例報告分析結果 / Case Report Analysis
========================================

【判定 / Judgement】
Priority: ${result.judgement}
Novelty Score: ${result.novelty_score}% (CATTO Level ${result.max_level_found} に基づく)

【理由 / Reasoning】
━━━━━━━━━━━━━━━━━━━━━━
${result.reasoning}

※ 上記の理由を日本語に翻訳してください。

【検索式 / Search Query】
━━━━━━━━━━━━━━━━━━━━━━
${queryDisplay}

【文献チェック / Quick Literature Check】
━━━━━━━━━━━━━━━━━━━━━━
${litCheckEmailText}

【入力されたCATTOデータ】
━━━━━━━━━━━━━━━━━━━━━━
A. Main Event (主事象):
${formData.main_event_1line}
...
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
