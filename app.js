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

document.getElementById('cattoForm').addEventListener('input', saveFormData);

// Helper to extract JSON from markdown text
function extractJson(text) {
    try {
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

// --- MeSH Validation & Search Pipeline Logic ---

const meshCache = {};

// Validate a term against NLM MeSH API
async function checkMeshTerm(term) {
    // Normalize: remove generic tags if present in string for lookup
    const cleanTerm = term.replace(/\[.*?\]/g, '').trim();

    if (meshCache[cleanTerm] !== undefined) {
        return meshCache[cleanTerm];
    }

    try {
        const url = `https://id.nlm.nih.gov/mesh/lookup/descriptor?label=${encodeURIComponent(cleanTerm)}&match=exact&limit=1`;
        const res = await fetch(url);
        const data = await res.json();
        const isValid = data.length > 0;
        meshCache[cleanTerm] = isValid;
        return isValid;
    } catch (e) {
        console.warn(`MeSH lookup failed for: ${cleanTerm}`, e);
        // Fail open or closed? Let's fail closed (assume invalid) to fallback to TIAB safe-mode
        return false;
    }
}

// Fetch count only (retmax=0)
async function fetchPubmedCount(query) {
    if (!query) return 0;
    const toolName = 'CaseReport-CATTO';
    const email = document.getElementById('submitter_email')?.value || 'user@example.com';
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=0&retmode=json&tool=${toolName}&email=${email}`;

    try {
        const res = await fetch(url);
        const data = await res.json();
        return parseInt(data.esearchresult?.count || '0', 10);
    } catch (e) {
        console.error('Count fetch failed:', e);
        return 0;
    }
}

// Main function to Validates Proposal & Rebuild Query
async function validateAndRebuildProposal(proposal) {
    const validatedBlocks = [];

    // Process each block
    for (const block of proposal.blocks) {
        const validMesh = [];
        const tiabList = Array.isArray(block.tiab_terms) ? [...block.tiab_terms] : [];
        const pendingMesh = Array.isArray(block.mesh_terms) ? block.mesh_terms : [];
        const meshStatus = {}; // term -> bool

        // Validate Candidate MeSH Terms
        for (const term of pendingMesh) {
            // Clean term
            const clean = term.replace(/\[.*?\]/g, '').trim();
            const isValid = await checkMeshTerm(clean);
            meshStatus[term] = isValid;

            if (isValid) {
                validMesh.push(`"${clean}"[MeSH Terms]`);
            } else {
                // Fallback to TIAB if invalid MeSH
                tiabList.push(clean);
            }
        }

        // Build MeSH part
        let meshQuery = '';
        if (validMesh.length > 0) {
            meshQuery = validMesh.join(' OR ');
        }

        // Build TIAB part
        let tiabQuery = '';
        if (tiabList.length > 0) {
            const mapped = tiabList.map(t => {
                const c = t.replace(/"/g, '').trim(); // Remove internal quotes if any
                return `"${c}"[tiab]`;
            });
            tiabQuery = mapped.join(' OR ');
        }

        // Combine for Block Query
        let combined = '';
        if (meshQuery && tiabQuery) {
            combined = `(${meshQuery} OR ${tiabQuery})`;
        } else if (meshQuery) {
            combined = `(${meshQuery})`;
        } else if (tiabQuery) {
            combined = `(${tiabQuery})`;
        }

        validatedBlocks.push({
            concept: block.concept,
            mesh_status: meshStatus,
            final_mesh: validMesh,
            final_tiab: tiabList,
            query: combined
        });
    }

    // Rebuild Final Query (AND logic across blocks)
    // Filter empty blocks
    const activeBlocks = validatedBlocks.filter(b => b.query && b.query.length > 0);
    const finalQuery = activeBlocks.map(b => b.query).join(' AND ');

    return {
        original: proposal,
        validated_blocks: validatedBlocks,
        final_query: finalQuery
    };
}

// Standard Search (returns IDs)
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
    const seeds = seedPmids.slice(0, 5);
    const toolName = 'CaseReport-CATTO';
    const email = document.getElementById('submitter_email')?.value || 'user@example.com';
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=pubmed&db=pubmed&linkname=pubmed_pubmed&cmd=neighbor_score&id=${seeds.join(',')}&retmode=json&tool=${toolName}&email=${email}`;

    try {
        const res = await fetch(url);
        const data = await res.json();
        let similarPmids = [];
        if (data.linksets) {
            for (const linkset of data.linksets) {
                if (linkset.linksetdbs) {
                    for (const db of linkset.linksetdbs) {
                        if (db.linkname === 'pubmed_pubmed' && db.links) {
                            const ids = db.links.slice(0, retmaxPerSeed).map(l => l.id);
                            similarPmids.push(...ids);
                        }
                    }
                }
            }
        }
        const seedSet = new Set(seeds);
        return [...new Set(similarPmids)].filter(id => !seedSet.has(id));
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
            const title = titleNode ? titleNode.textContent : '';
            const abstractTexts = article.querySelectorAll('AbstractText');
            const abstract = Array.from(abstractTexts).map(t => t.textContent).join(' ') || 'No abstract available';
            const journalNode = article.querySelector('Journal > Title');
            const journal = journalNode ? journalNode.textContent : (article.querySelector('Journal Title')?.textContent || '');

            let year = article.querySelector('PubDate > Year')?.textContent;
            if (!year) {
                const medlineDate = article.querySelector('PubDate > MedlineDate')?.textContent;
                if (medlineDate) {
                    const match = medlineDate.match(/\d{4}/);
                    year = match ? match[0] : 'N/A';
                } else { year = 'N/A'; }
            }

            let doi = '';
            const articleIds = article.querySelectorAll('ArticleId');
            for (const id of articleIds) {
                if (id.getAttribute('IdType') === 'doi') {
                    doi = id.textContent;
                    break;
                }
            }
            const pubmedUrl = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
            return { pmid, title, abstract, journal, year, doi, url: pubmedUrl };
        } catch (e) { return null; }
    }).filter(a => a !== null);
}

// --- Main Handler ---

document.getElementById('cattoForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    if (!apiKey) { alert('APIキーを設定してください'); return; }

    const btn = document.getElementById('analyzeBtn');
    const btnText = document.getElementById('btnText');
    const spinner = document.getElementById('spinner');
    const results = document.getElementById('results');

    btnText.textContent = 'Generating Clnical Abstract & Search Strategy...';
    spinner.style.display = 'inline-block';
    btn.disabled = true;
    results.style.display = 'none';

    try {
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

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

        // Step 1-3 Prompt: Request Structured Proposal AND Case Summary
        const prePrompt = `
You are an expert Anesthesiologist and Researcher.
Perform the following STEPS based on the input Case Report data.
Output strictly in JSON format.

INPUT DATA:
${JSON.stringify(formData, null, 2)}

STEP 1: Case Summary & CATTO Reconstruction
1. "case_summary": Generate a concise, professional Clinical Abstract (2-3 sentences) summarizing the user's input (A-H). This should read like the start of a paper.
2. "reconstructed_catto": Reconstruct the case event into a standardized definition.

STEP 2: Search Core Definition
Define the "Search Core" for PubMed.

STEP 3: Search Strategy Proposal
Design a PubMed search strategy using "Blocks" (e.g., Block 1 = Condition, Block 2 = Anatomy, etc.).
For each block, suggest:
- 'mesh_terms': High-value MeSH candidates. Do NOT try to be too clever; use standard terms if unsure.
- 'tiab_terms': Keywords for Title/Abstract search.
- The system will automatically validate MeSH terms. If invalid, they will be moved to TIAB.

OUTPUT JSON FORMAT:
{
  "case_summary": "A 45-year-old male presented with...",
  "reconstructed_catto": { ... },
  "search_core": { ... },
  "search_proposal": {
    "framework": "CATTO",
    "blocks": [
      {
        "concept": "Condition/Event",
        "mesh_terms": ["Term A", "Term B"], 
        "tiab_terms": ["Term A", "Synonym C"]
      },
      {
        "concept": "Anatomy/Procedure",
        "mesh_terms": ["..."],
        "tiab_terms": ["..."]
      }
    ]
  }
}
`;

        console.log('Generating Proposal...');
        const preResult = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prePrompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        });
        const preJson = extractJson(preResult.response.text());

        // --- MeSH Validation & Reconstruction ---
        console.log('Validating MeSH terms...');
        btnText.textContent = 'Validating MeSH Terms...';

        const validatedProposal = await validateAndRebuildProposal(preJson.search_proposal);

        // --- Count Audit ---
        console.log('Auditing result counts...');
        btnText.textContent = 'Checking PubMed Counts...';

        // 1. Narrow (All Blocks ANDed)
        const narrowQuery = validatedProposal.final_query;
        const narrowCount = await fetchPubmedCount(narrowQuery);

        // 2. Broad
        let broadQuery = narrowQuery;
        if (validatedProposal.validated_blocks.length > 2) {
            const sub = validatedProposal.validated_blocks.slice(0, validatedProposal.validated_blocks.length - 1);
            broadQuery = sub.map(b => b.query).join(' AND ');
        } else {
            if (validatedProposal.validated_blocks.length > 0) {
                broadQuery = validatedProposal.validated_blocks[0].query;
            }
        }

        const broadCount = await fetchPubmedCount(broadQuery);

        console.log(`Counts -> Narrow: ${narrowCount}, Broad: ${broadCount}`);

        // Decision Logic
        let finalQueryToUse = narrowQuery;
        if (narrowCount >= 5 && narrowCount <= 300) {
            finalQueryToUse = narrowQuery;
        } else if (narrowCount < 5) {
            if (broadCount > 0) {
                console.log('Narrow too small, switching to Broad');
                finalQueryToUse = broadQuery;
            } else {
                console.log('Both zero. Sticking to narrow to show 0 result.');
                finalQueryToUse = narrowQuery;
            }
        } else if (narrowCount > 500) {
            finalQueryToUse = narrowQuery;
        }

        // --- Execution ---
        console.log('Searching PubMed...');
        btnText.textContent = `Searching (${finalQueryToUse === narrowQuery ? 'Narrow' : 'Broad'})...`;

        let pmids = await searchPubMed(finalQueryToUse, 100);

        // Expansion (ELink)
        const similarPmids = await fetchSimilarPmidsByElink(pmids, 10);
        const pmidSet = new Set(pmids);
        for (const pid of similarPmids) {
            if (!pmidSet.has(pid)) {
                pmids.push(pid);
            }
        }

        const topPmids = pmids.slice(0, 80);
        const papers = await fetchPubMedDetails(topPmids);

        // --- Step 4-7 Evaluation ---
        let finalResult;

        if (papers.length === 0) {
            finalResult = {
                ...preJson,
                search_proposal: validatedProposal,
                counts: { narrow: narrowCount, broad: broadCount, used: finalQueryToUse },
                max_level_found: 0,
                judgement: 'High',
                reasoning: 'No relevant papers found in PubMed matching the generated search queries.',
                quick_lit_check: [],
                novelty_score: 90,
                knowledge_gap: 'No comparative literature found (0 results).',
                knowledge_gap_notes: 'Determined by lack of verified matching papers.',
                novelty_sharpeners: ['Detailed Timeline', 'Hemodynamic data', 'Photos/Imaging', 'Follow-up']
            };
        } else {
            // Prepare Papers for LLM
            const papersForLLM = papers.map((p, i) => `[P${i + 1}] Abstract: ${p.abstract}`).join('\n\n');

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
Select the TOP 5 most relevant papers from the provided list, sorted by match level (High to Low).
- You MUST select 5 papers if available, even if they are low match (Level 1 or 0) or generic.
- The user wants to see the "closest" matches found.
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
  "selected_paper_ids": [1, 2, 3, 4, 5],
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
  "reasoning_with_ids": "Explain the novelty by explicitly comparing the case to the literature using CATTO structure:\\n- Condition/Event: ...\\n- Anatomy: ...\\n- Trigger/Timing: ...\\n- Conclusion: ...\\nWHEN CITING PAPERS, YOU MUST USE THE FORMAT [P1], [P2], etc."
}
`;

            const evalResult = await model.generateContent({
                contents: [{ role: "user", parts: [{ text: evalPrompt }] }],
                generationConfig: { responseMimeType: "application/json" }
            });
            const evalJson = extractJson(evalResult.response.text());

            // --- Verification Logic ---
            const validatedLitCheck = [];
            let verifiedMaxLevel = 0;
            let systemNotes = [];

            let rawSelectedIds = evalJson.selected_paper_ids || [];
            if (!Array.isArray(rawSelectedIds)) rawSelectedIds = [rawSelectedIds];

            let evals = evalJson.paper_evaluations || [];

            const extractId = (val) => {
                const s = String(val);
                const match = s.match(/(\d+)/);
                return match ? parseInt(match[1], 10) : null;
            };

            const validEvaluations = evals.map(ev => {
                ev._cleanId = extractId(ev.paper_id);
                return ev;
            }).filter(ev => ev._cleanId !== null && ev._cleanId >= 1 && ev._cleanId <= papers.length);

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
                    const qRaw = qClean.replace(/^["']|["']$/g, '');
                    if (qRaw.length > 5 && abstractLower.includes(qRaw)) {
                        matchCount++;
                        validQuotes.push(q);
                    }
                });

                let finalLevel = ev.match_level;
                let note = '';

                if (quotes.length === 0) {
                    finalLevel = 1;
                    note = 'No evidence provided';
                } else if (matchCount === 0) {
                    finalLevel = 0;
                    note = 'Hallucinated evidence invalidated';
                } else if (matchCount < quotes.length) {
                    finalLevel = Math.max(1, finalLevel - 1);
                    note = 'Partial evidence match';
                }

                if (finalLevel > verifiedMaxLevel) {
                    verifiedMaxLevel = finalLevel;
                }

                // Keep even level 0 if selected by AI as "closest", just verify quotes.
                // But usually we filter invalidated. User requested "Top 5". 
                // Let's include them but mark as verified Level 0 if invalidated.
                validatedLitCheck.push({
                    pmid: paper.pmid,
                    doi: paper.doi || '',
                    title: paper.title,
                    url: paper.url,
                    abstract: paper.abstract,
                    matched_elements: ev.matched_elements || 'N/A',
                    unmatched_elements: ev.unmatched_elements || 'N/A',
                    difference: ev.difference || 'N/A',
                    evidence_quotes: validQuotes,
                    verification_note: note,
                    verified_level: finalLevel
                });
            }

            validatedLitCheck.sort((a, b) => b.verified_level - a.verified_level);

            // Reconstruct Reasoning
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

            // Recalculate Judgement
            let finalJudgement = 'Low';
            let calcScore = 0;
            if (verifiedMaxLevel >= 4) {
                calcScore = 15;
                finalJudgement = 'Low';
            } else if (verifiedMaxLevel === 3) {
                calcScore = 40;
                finalJudgement = 'Low';
            } else if (verifiedMaxLevel === 2) {
                calcScore = 70;
                finalJudgement = 'Moderate';
            } else {
                calcScore = 90;
                finalJudgement = 'High';
            }

            // --- STEP 7: KNOWLEDGE GAP & NOVELTY SHARPENERS ---
            console.log('Step 7: Identifying Knowledge Gaps & Novelty Sharpeners...');
            let step7Result = {
                knowledge_gap: '',
                novelty_sharpeners: [],
                knowledge_gap_notes: ''
            };

            if (validatedLitCheck.length > 0) {
                const verifiedContext = validatedLitCheck.map(p => ({
                    title: p.title,
                    pmid: p.pmid,
                    verified_level: p.verified_level,
                    verified_evidence_quotes: p.evidence_quotes || []
                }));

                const step7Prompt = `
You are an expert Medical Editor.
Perform STEP 7 based on the VERIFIED analysis results.
Output strictly in JSON format.

INPUTS:
- Verified Match Level: ${verifiedMaxLevel}
- Validated Literature (Only trusted evidence quotes are provided):
${JSON.stringify(verifiedContext, null, 2)}
- Case Input Subject:
${JSON.stringify(preJson.reconstructed_catto, null, 2)}

STEP 7 TASKS:
1. Knowledge Gap: Explain what is missing in the literature compared to this case.
   - Base this ONLY on the provided "verified_evidence_quotes" and "verified_level".
   - If verified_level is low (1-2), emphasize the lack of specific matching reports.
2. Novelty Sharpeners: Suggest 5-8 specific data points or details the author should ADD to their Case Report to strengthen its novelty.

OUTPUT JSON FORMAT:
{
  "knowledge_gap": "...",
  "novelty_sharpeners": ["...", "..."],
  "knowledge_gap_notes": "..." 
}
`;
                try {
                    const step7Res = await model.generateContent({
                        contents: [{ role: "user", parts: [{ text: step7Prompt }] }],
                        generationConfig: { responseMimeType: "application/json" }
                    });
                    const step7Json = extractJson(step7Res.response.text());
                    step7Result = step7Json;
                } catch (e) {
                    console.error('Step 7 failed:', e);
                    step7Result = {
                        knowledge_gap: 'Analysis failed during Step 7.',
                        novelty_sharpeners: [],
                        knowledge_gap_notes: 'Error in generation.'
                    };
                }
            } else {
                step7Result = {
                    knowledge_gap: 'No validated literature was found to be sufficiently similar.',
                    knowledge_gap_notes: 'Determined by lack of verified matching papers.',
                    novelty_sharpeners: ['Detailed Timeline', 'Hemodynamic data', 'Photos/Imaging', 'Follow-up']
                };
            }


            finalResult = {
                ...preJson,
                max_level_found: verifiedMaxLevel,
                judgement: finalJudgement,
                reasoning: finalReasoning,
                quick_lit_check: validatedLitCheck,
                novelty_score: calcScore,
                pubmed_query: preJson.pubmed_query,
                knowledge_gap: step7Result.knowledge_gap,
                knowledge_gap_notes: step7Result.knowledge_gap_notes,
                novelty_sharpeners: step7Result.novelty_sharpeners
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

    // 1. Case Summary (Results Top)
    const summaryHtml = `
    <div style="margin-bottom: 20px; padding: 15px; background: rgba(0,0,0,0.3); border-radius: 8px; border-left: 4px solid var(--secondary);">
        <h3 style="margin-top:0; font-size: 1.1rem; color: var(--secondary);">Case Summary (Clinical Abstract)</h3>
        <p style="margin:0; font-style: italic; color: #e2e8f0;">"${result.case_summary || 'No summary available.'}"</p>
    </div>`;

    document.getElementById('reconstructedCatto').textContent = JSON.stringify(result.reconstructed_catto, null, 2);
    document.getElementById('searchCore').textContent = JSON.stringify(result.search_core, null, 2);

    // Search Audit UI
    const proposal = result.search_proposal;
    let strategyHtml = `<div style="background: rgba(0,0,0,0.3); padding: 10px; border-radius: 8px; margin-bottom: 20px;">
        <h4 style="margin-top:0;">Search Strategy Audit</h4>
        <div style="display:flex; gap:10px; flex-wrap:wrap;">`;

    if (proposal && proposal.validated_blocks) {
        proposal.validated_blocks.forEach((block, idx) => {
            let meshBadges = '';
            for (const [term, valid] of Object.entries(block.mesh_status || {})) {
                const color = valid ? '#4ade80' : '#f87171';
                const icon = valid ? '✓' : '✗';
                meshBadges += `<span style="display:inline-block; font-size:0.75rem; border:1px solid ${color}; color:${color}; padding:2px 6px; border-radius:10px; margin-right:4px;">${icon} ${term}</span>`;
            }
            strategyHtml += `
            <div style="flex:1; min-width: 250px; background: rgba(255,255,255,0.05); padding:8px; border-radius:6px;">
                <div style="font-weight:bold; font-size:0.9rem; color:var(--secondary); margin-bottom:4px;">Block ${idx + 1}: ${block.concept}</div>
                <div style="margin-bottom:4px;">${meshBadges}</div>
                <div style="font-family:monospace; font-size:0.75rem; color:#a1a1aa; word-break:break-all;">${block.query}</div>
            </div>`;
        });
    }
    strategyHtml += `</div>
        <div style="margin-top:10px; font-size:0.9rem; display:flex; justify-content:space-between; align-items:center; border-top:1px solid rgba(255,255,255,0.1); padding-top:8px;">
            <div>
                <strong>Counts:</strong> Narrow <span style="color:#fbbf24">${result.counts?.narrow}</span> | Broad <span style="color:#fbbf24">${result.counts?.broad}</span>
            </div>
            <div>
                 Used: <span style="font-family:monospace; background:rgba(255,255,255,0.1); padding:2px 6px; border-radius:4px;">${result.counts?.used === result.search_proposal.final_query ? 'Narrow' : 'Broad'}</span>
            </div>
        </div>
    </div>`;


    let litCheckHtml = `<h3>Quick Literature Check (${totalPapers} papers found)</h3>` + strategyHtml;
    let litCheckEmailText = '';

    if (totalPapers === 0) {
        litCheckHtml += `<div style="background: rgba(251, 191, 36, 0.1); border: 1px solid rgba(251, 191, 36, 0.3); padding: 10px; border-radius: 6px; margin-bottom: 15px; font-size: 0.9rem; color: #fbbf24;">
            ⚠️ PubMed query returned 0 results. No literature available for verification.
        </div>`;
    }

    if (result.quick_lit_check && result.quick_lit_check.length > 0) {
        litCheckHtml += '<ul>'; // Start unordered list for papers
        result.quick_lit_check.forEach((cite, idx) => {
            const doiDisplay = cite.doi ? ` | DOI: ${cite.doi}` : '';
            // Format quotes
            let quotesHtml = '';
            if (cite.evidence_quotes && cite.evidence_quotes.length > 0) {
                quotesHtml = `<div style="margin-top: 0.5rem; font-style: italic; color: #a1a1aa; border-left: 2px solid #52525b; padding-left: 8px;">"${cite.evidence_quotes.join('"<br>"')}"</div>`;
            }
            // Format verification note
            const noteHtml = cite.verification_note ? `<span style="font-size: 0.8rem; color: #fbbf24; margin-left: 5px;">(${cite.verification_note})</span>` : '';

            litCheckHtml += `
                <li style="margin-bottom: 0.75rem; padding: 0.75rem; background: rgba(0,0,0,0.2); border-radius: 8px;">
                    <div style="font-weight: bold;">
                        <span style="color:var(--secondary);">[#${idx + 1}]</span> <a href="${cite.url}" target="_blank" style="color: white; text-decoration: none;">${cite.title}</a>
                        ${noteHtml}
                    </div>
                    <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 0.25rem;">
                       PMID: ${cite.pmid}${doiDisplay} | Match Level: ${cite.verified_level}
                    </div>
                    ${quotesHtml}
                    <div style="font-size: 0.9rem; margin-top: 0.5rem;">
                       <strong>Matched:</strong> ${cite.matched_elements}<br/>
                       <strong>Unmatched:</strong> ${cite.unmatched_elements}<br/>
                       <strong>Difference:</strong> ${cite.difference}
                    </div>
                </li>
            `;
            litCheckEmailText += `[${idx + 1}] ${cite.title} (PMID: ${cite.pmid}) \n`;
        });
    } else {
        litCheckHtml += '<li>No specific papers listed (or all invalidated).</li>';
        litCheckEmailText = 'No verified matches found.\n';
    }
    litCheckHtml += '</ul>';

    const gapHtml = `< div style = "margin:20px 0; padding:15px; background:rgba(255,255,255,0.03); border-radius:8px;" >
        <h4 style="margin-top:0; color:var(--secondary)">Knowledge Gap</h4>
        <p>${result.knowledge_gap}</p>
    </div > `;

    const sharpHtml = `< div style = "margin:20px 0; padding:15px; background:rgba(255,255,255,0.03); border-radius:8px;" >
        <h4 style="margin-top:0; color:#fbbf24">Novelty Sharpeners</h4>
        <ul>${(result.novelty_sharpeners || []).map(s => `<li>${s}</li>`).join('')}</ul>
    </div > `;

    document.getElementById('resultContent').innerHTML = `
        ${summaryHtml}
            <div style="margin-bottom: 1.5rem;">
                <h3>Reasoning</h3>
                <p>${result.reasoning}</p>
                <p style="font-size: 0.9rem; color: var(--text-muted); margin-top: 5px;">
                    <em>(Score calculated based on Max Match Level: ${result.max_level_found})</em>
                </p>
            </div>
        ${gapHtml}
        ${sharpHtml}
        ${litCheckHtml}
            `;

    // --- Email Button Logic ---
    const emailBody = `Subject: Case Report Novelty Analysis Request

            [Case Summary]
${result.case_summary || 'N/A'}

            [Novelty Score]
            Score: ${result.novelty_score}
            Judgement: ${result.judgement} Priority

            [Reasoning]
${result.reasoning}

            [Knowledge Gap]
${result.knowledge_gap}

            [Novelty Sharpeners]
${(result.novelty_sharpeners || []).map(s => '- ' + s).join('\n')}

            [Quick Literature Check]
${litCheckEmailText}

            [Original Input]
            Condition: ${formData.condition_event}
            Anatomy: ${formData.anatomy}
            Trigger: ${formData.trigger_exposure}
            Timing: ${formData.timing}
Key Findings: ${formData.key_findings}
            Management: ${formData.management_outcome}
Novelty Claim: ${formData.novelty_differences}
            `;

    const mailtoLink = `mailto:? subject = ${encodeURIComponent('Case Report Analysis Result')}& body=${encodeURIComponent(emailBody)} `;

    const emailBtnHtml = `
                < div style = "margin-top: 30px; text-align: center;" >
                    <a href="${mailtoLink}" class="btn" style="background: var(--secondary); color: black; text-decoration: none; display: inline-block; padding: 10px 20px; border-radius: 6px; font-weight: bold;">
                        Open Email Draft
                    </a>
    </div > `;

    document.getElementById('resultContent').insertAdjacentHTML('beforeend', emailBtnHtml);

    results.style.display = 'block';
    results.scrollIntoView({ behavior: 'smooth' });
}

