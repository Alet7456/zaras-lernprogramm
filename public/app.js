// ============================================================
// Zaras Lernprogramm - Intelligente Karteikarten App
// ============================================================

// --- State ---
let chapters = [];
let selectedChapterIds = [];
let parsedTopics = [];
let studySession = null;
let currentUser = null;       // extracted from URL /user/:name
let saveTimeout = null;       // debounce server saves

// --- User from URL ---
function getUserFromUrl() {
    const match = window.location.pathname.match(/^\/user\/([^/]+)/);
    return match ? decodeURIComponent(match[1]).toLowerCase().trim() : null;
}

// --- Server Storage ---
async function loadChapters() {
    if (!currentUser) return;
    try {
        const res = await fetch(`/api/user/${encodeURIComponent(currentUser)}`);
        const data = await res.json();
        chapters = data.chapters || [];
    } catch (err) {
        console.error('Fehler beim Laden:', err);
        chapters = [];
    }
}

function saveChapters() {
    // Debounce: wait 300ms before saving to avoid spamming the server
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        if (!currentUser) return;
        fetch(`/api/user/${encodeURIComponent(currentUser)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chapters })
        }).catch(err => console.error('Fehler beim Speichern:', err));
    }, 300);
}

// API key + model stay in localStorage (per device, sensitive)
function getApiKey() {
    return localStorage.getItem('zaras-api-key') || '';
}

function setApiKey(key) {
    localStorage.setItem('zaras-api-key', key);
}

function getModel() {
    return localStorage.getItem('zaras-model') || 'claude-sonnet-4-6';
}

function setModel(model) {
    localStorage.setItem('zaras-model', model);
}

// --- Settings ---
function openSettings() {
    document.getElementById('api-key-input').value = getApiKey();
    document.getElementById('model-select').value = getModel();
    document.getElementById('settings-overlay').style.display = 'flex';
}

function closeSettings(event) {
    if (event && event.target !== event.currentTarget) return;
    document.getElementById('settings-overlay').style.display = 'none';
}

function saveSettings() {
    const key = document.getElementById('api-key-input').value.trim();
    const model = document.getElementById('model-select').value;
    setApiKey(key);
    setModel(model);
    closeSettings();
    alert('Einstellungen gespeichert!');
}

// --- Spaced Repetition Algorithm (Priority/Ordering) ---
function getCardPriority(history) {
    const len = history.length;
    if (len === 0) return 0;

    const last = history[len - 1];

    if (len === 1) {
        if (last === 'correct') return 12;
        if (last === 'hard') return 6;
        return 1;
    }

    const prev = history[len - 2];

    if (prev === 'correct' && last === 'correct') return 'done';
    if (prev === 'correct' && last === 'hard') return 12;
    if (prev === 'correct' && last === 'wrong') return 6;

    if (prev === 'hard' && last === 'correct') return 12;
    if (prev === 'hard' && last === 'hard') return 6;
    if (prev === 'hard' && last === 'wrong') return 1;

    if (prev === 'wrong' && last === 'correct') return 12;
    if (prev === 'wrong' && last === 'hard') return 6;
    if (prev === 'wrong' && last === 'wrong') return 1;

    if (last === 'correct' && prev === 'correct') return 'done';
    if (last === 'correct') return 12;
    if (last === 'hard') return 6;
    return 1;
}

function getInsertPosition(priority, queueLength) {
    if (priority === 'done') return -1;
    if (queueLength === 0) return 0;

    const fraction = priority === 1 ? 0.1 : priority === 6 ? 0.35 : 0.65;
    const pos = Math.max(1, Math.round(queueLength * fraction));
    const jitter = Math.floor(Math.random() * Math.max(1, Math.round(queueLength * 0.08)));
    return Math.min(pos + jitter, queueLength);
}

// --- Claude API ---
async function callClaude(prompt, documentText) {
    const apiKey = getApiKey();
    if (!apiKey) {
        throw new Error('Kein API-Key gesetzt. Bitte gehe zu Einstellungen und gib deinen Claude API-Key ein.');
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
            model: getModel(),
            max_tokens: 4096,
            messages: [{
                role: 'user',
                content: prompt + '\n\n--- DOKUMENT ---\n\n' + documentText
            }]
        })
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        if (response.status === 401) {
            throw new Error('Ungültiger API-Key. Bitte überprüfe deinen Key in den Einstellungen.');
        }
        throw new Error(err.error?.message || `API-Fehler: ${response.status}`);
    }

    const data = await response.json();
    return data.content[0].text;
}

async function generateCardsWithAI(documentText) {
    const prompt = `Du bist ein Experte für Lernmethoden und Karteikarten-Erstellung. Analysiere den folgenden Dokumenttext und erstelle daraus optimale Karteikarten zum Lernen.

WICHTIGE REGELN:
1. Teile den Inhalt in sinnvolle Topics/Themen ein (basierend auf Überschriften oder inhaltlichen Abschnitten)
2. Erstelle pro Topic mehrere Karteikarten
3. Jede Karteikarte hat eine FRAGE (front) und eine ANTWORT (back)
4. Die Fragen sollen GEZIELT und PRÄZISE sein - keine vagen "Was weißt du über X?" Fragen
5. Nutze verschiedene Fragetypen: Definitionen, Zusammenhänge, Vergleiche, Anwendungen, Ursache-Wirkung
6. Die Antworten sollen als STICHPUNKTE formatiert sein (mit "• " als Aufzählungszeichen), z.B. "• Punkt 1\n• Punkt 2\n• Punkt 3". Kein Fließtext, aber JEDES Detail aus dem Originaltext muss enthalten sein
7. Frage nach konkreten Fakten, Begriffen, Prozessen und Zusammenhängen
8. KEIN INHALT DARF WEGGELASSEN WERDEN. Jede Information, jedes Detail, jede Zahl, jeder Begriff aus dem Dokument muss in mindestens einer Karteikarte vorkommen. Lieber mehr Karten erstellen als Inhalte weglassen
9. Erstelle so viele Karten wie nötig, um den GESAMTEN Inhalt abzudecken - mindestens 3 pro Topic

Antworte AUSSCHLIESSLICH mit gültigem JSON in diesem Format (kein anderer Text!):
{
  "topics": [
    {
      "name": "Topic-Name",
      "cards": [
        { "front": "Präzise Frage?", "back": "Knappe, vollständige Antwort" }
      ]
    }
  ]
}`;

    const result = await callClaude(prompt, documentText);

    let jsonStr = result;
    const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
    }

    const parsed = JSON.parse(jsonStr);

    return parsed.topics.map(topic => ({
        id: generateId(),
        name: topic.name,
        cards: topic.cards.map(card => ({
            id: generateId(),
            front: card.front,
            back: card.back,
            history: [],
            nextReview: 0
        }))
    }));
}

// --- Document Parser ---
async function extractTextFromDocx(file) {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.convertToHtml({ arrayBuffer });
    const html = result.value;

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    let text = '';
    for (const el of doc.body.children) {
        const tag = el.tagName.toLowerCase();
        const content = el.textContent.trim();
        if (!content) continue;

        if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
            text += `\n\n## ${content}\n\n`;
        } else {
            text += content + '\n';
        }
    }
    return text.trim();
}

function generateCardsFallback(documentText) {
    const sections = documentText.split(/\n\n##\s+/);
    const topics = [];

    for (const section of sections) {
        const lines = section.trim().split('\n').filter(l => l.trim());
        if (lines.length === 0) continue;

        const name = lines[0].replace(/^#+\s*/, '').trim() || 'Allgemein';
        const content = lines.slice(1).join('\n').trim();
        if (!content) continue;

        const paragraphs = content.split(/\n\s*/).filter(p => p.trim().length > 10);
        const cards = paragraphs.map(para => ({
            id: generateId(),
            front: para.length > 80 ? para.substring(0, 80) + '...?' : para + '?',
            back: para,
            history: [],
            nextReview: 0
        }));

        if (cards.length > 0) {
            topics.push({ id: generateId(), name, cards });
        }
    }

    return topics.length > 0 ? topics : [{
        id: generateId(),
        name: 'Allgemein',
        cards: [{ id: generateId(), front: 'Kein Inhalt erkannt', back: documentText.substring(0, 200), history: [], nextReview: 0 }]
    }];
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

// --- Loading Overlay ---
function showLoading(status) {
    document.getElementById('loading-status').textContent = status || 'Bitte warten...';
    document.getElementById('loading-overlay').style.display = 'flex';
}

function hideLoading() {
    document.getElementById('loading-overlay').style.display = 'none';
}

// --- View Management ---
function showView(viewName) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${viewName}`).classList.add('active');

    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    const activeBtn = document.querySelector(`.nav-btn[data-view="${viewName}"]`);
    if (activeBtn) activeBtn.classList.add('active');

    if (viewName === 'dashboard') renderDashboard();
}

// --- Dashboard ---
function renderDashboard() {
    const list = document.getElementById('chapter-list');
    const empty = document.getElementById('no-chapters');
    const studyBar = document.getElementById('study-bar');

    if (chapters.length === 0) {
        list.style.display = 'none';
        empty.style.display = 'block';
        studyBar.style.display = 'none';
        return;
    }

    list.style.display = 'grid';
    empty.style.display = 'none';

    list.innerHTML = chapters.map(ch => {
        const totalCards = ch.topics.reduce((sum, t) => sum + t.cards.length, 0);
        const reviewedCards = ch.topics.reduce((sum, t) =>
            sum + t.cards.filter(c => c.history.length >= 2 && c.history[c.history.length - 1] === 'correct' && c.history[c.history.length - 2] === 'correct').length, 0);
        const progress = totalCards > 0 ? Math.round((reviewedCards / totalCards) * 100) : 0;
        const isSelected = selectedChapterIds.includes(ch.id);
        const date = new Date(ch.createdAt).toLocaleDateString('de-DE', {
            day: '2-digit', month: '2-digit', year: 'numeric'
        });

        return `
            <div class="chapter-card ${isSelected ? 'selected' : ''}" data-id="${ch.id}">
                <div class="chapter-card-header">
                    <div>
                        <h3>${escapeHtml(ch.name)}</h3>
                        <div class="chapter-card-date">${date}</div>
                    </div>
                    <div class="chapter-select ${isSelected ? 'checked' : ''}"
                         onclick="event.stopPropagation(); toggleChapterSelect('${ch.id}')"></div>
                </div>
                <div class="chapter-card-meta">
                    <span>${ch.topics.length} Topics</span>
                    <span>${totalCards} Karten</span>
                    <span>${progress}% gelernt</span>
                </div>
                <div class="chapter-card-progress">
                    <div class="chapter-card-progress-fill" style="width: ${progress}%"></div>
                </div>
                <div class="chapter-card-actions">
                    <button class="btn btn-primary btn-sm" onclick="event.stopPropagation(); quickStudy('${ch.id}')">Lernen</button>
                    <div class="kebab-wrapper">
                        <button class="kebab-btn" onclick="event.stopPropagation(); toggleKebab('${ch.id}')">&#8942;</button>
                        <div class="kebab-menu" id="kebab-${ch.id}">
                            <button onclick="event.stopPropagation(); closeAllKebabs(); showChapterDetail('${ch.id}')">Details</button>
                            <button onclick="event.stopPropagation(); closeAllKebabs(); resetChapterProgress('${ch.id}')">Fortschritt zurücksetzen</button>
                            <button class="kebab-danger" onclick="event.stopPropagation(); closeAllKebabs(); deleteChapter('${ch.id}')">Löschen</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    if (selectedChapterIds.length > 0) {
        studyBar.style.display = 'flex';
        document.getElementById('selected-count').textContent =
            `${selectedChapterIds.length} Kapitel ausgewählt`;
    } else {
        studyBar.style.display = 'none';
    }
}

function toggleChapterSelect(id) {
    const idx = selectedChapterIds.indexOf(id);
    if (idx >= 0) selectedChapterIds.splice(idx, 1);
    else selectedChapterIds.push(id);
    renderDashboard();
}

function quickStudy(id) {
    selectedChapterIds = [id];
    startStudySetup();
}

function toggleKebab(id) {
    const menu = document.getElementById(`kebab-${id}`);
    const wasOpen = menu.classList.contains('open');
    closeAllKebabs();
    if (!wasOpen) menu.classList.add('open');
}

function closeAllKebabs() {
    document.querySelectorAll('.kebab-menu.open').forEach(m => m.classList.remove('open'));
}

function resetChapterProgress(id) {
    if (!confirm('Fortschritt für dieses Kapitel wirklich zurücksetzen?')) return;
    const ch = chapters.find(c => c.id === id);
    if (!ch) return;
    for (const topic of ch.topics) {
        for (const card of topic.cards) {
            card.history = [];
            card.nextReview = 0;
        }
    }
    saveChapters();
    renderDashboard();
}

function deleteChapter(id) {
    if (!confirm('Kapitel wirklich löschen? Fortschritt geht verloren.')) return;
    chapters = chapters.filter(c => c.id !== id);
    selectedChapterIds = selectedChapterIds.filter(sid => sid !== id);
    saveChapters();
    renderDashboard();
}

function showChapterDetail(id) {
    const ch = chapters.find(c => c.id === id);
    if (!ch) return;

    document.getElementById('modal-title').textContent = ch.name;
    const content = document.getElementById('modal-content');

    content.innerHTML = ch.topics.map(t => `
        <div class="modal-topic">
            <div class="modal-topic-name">${escapeHtml(t.name)} (${t.cards.length} Karten)</div>
            ${t.cards.map(c => `
                <div class="modal-card-item">
                    <strong>F:</strong> ${escapeHtml(c.front)}<br>
                    <strong>A:</strong> ${escapeHtml(c.back)}
                    ${c.history.length > 0 ? `<br><small style="color:var(--text-muted)">Versuche: ${c.history.length} | Letzte: ${c.history[c.history.length-1]}</small>` : ''}
                </div>
            `).join('')}
        </div>
    `).join('');

    document.getElementById('modal-overlay').style.display = 'flex';
}

function closeModal(event) {
    if (event && event.target !== event.currentTarget) return;
    document.getElementById('modal-overlay').style.display = 'none';
}

// --- Upload ---
function initUpload() {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');

    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        if (file && file.name.endsWith('.docx')) handleFile(file);
        else alert('Bitte eine .docx Datei hochladen.');
    });

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) handleFile(file);
    });
}

async function handleFile(file) {
    try {
        showLoading('Dokument wird gelesen...');

        const documentText = await extractTextFromDocx(file);

        if (!documentText || documentText.length < 20) {
            hideLoading();
            alert('Keine Inhalte gefunden. Stelle sicher, dass die Datei Text enthält.');
            return;
        }

        const apiKey = getApiKey();

        if (apiKey) {
            showLoading('KI analysiert Dokument und erstellt Karteikarten...');
            try {
                parsedTopics = await generateCardsWithAI(documentText);
            } catch (err) {
                console.error('AI Error:', err);
                hideLoading();
                const useFallback = confirm(
                    `KI-Fehler: ${err.message}\n\nMöchtest du stattdessen die einfache Karteikarten-Erstellung nutzen?`
                );
                if (useFallback) {
                    parsedTopics = generateCardsFallback(documentText);
                } else {
                    return;
                }
            }
        } else {
            const wantAI = confirm(
                'Kein API-Key gesetzt. Möchtest du die KI-Karteikarten-Erstellung nutzen?\n\n' +
                'Klicke "OK" um zu den Einstellungen zu gehen, oder "Abbrechen" für einfache Erstellung.'
            );
            if (wantAI) {
                hideLoading();
                openSettings();
                return;
            }
            parsedTopics = generateCardsFallback(documentText);
        }

        hideLoading();

        if (parsedTopics.length === 0 || parsedTopics.every(t => t.cards.length === 0)) {
            alert('Keine Karteikarten erstellt. Versuche es mit einer anderen Datei.');
            return;
        }

        const nameInput = document.getElementById('chapter-name');
        nameInput.value = file.name.replace('.docx', '');

        renderTopicsPreview();

        document.getElementById('drop-zone').style.display = 'none';
        document.getElementById('upload-preview').style.display = 'block';
    } catch (err) {
        hideLoading();
        console.error(err);
        alert('Fehler beim Lesen der Datei: ' + err.message);
    }
}

function renderTopicsPreview() {
    const container = document.getElementById('topics-preview');
    const totalCards = parsedTopics.reduce((sum, t) => sum + t.cards.length, 0);
    container.innerHTML = `<h3 style="margin-bottom:12px;">Erkannte Topics (${parsedTopics.length}) &mdash; ${totalCards} Karten</h3>` +
        parsedTopics.map((t, i) => `
            <div class="topic-group">
                <div class="topic-header" onclick="toggleTopicPreview(${i})">
                    <span>${escapeHtml(t.name)}</span>
                    <span class="topic-cards-count">${t.cards.length} Karten</span>
                </div>
                <div class="topic-cards-list" id="topic-preview-${i}">
                    ${t.cards.map(c => `
                        <div class="preview-card">
                            <div class="preview-card-side">
                                <div class="preview-card-label">Frage</div>
                                <div class="preview-card-text">${escapeHtml(c.front)}</div>
                            </div>
                            <div class="preview-card-side">
                                <div class="preview-card-label">Antwort</div>
                                <div class="preview-card-text">${escapeHtml(c.back)}</div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `).join('');
}

function toggleTopicPreview(index) {
    document.getElementById(`topic-preview-${index}`).classList.toggle('open');
}

function saveChapter() {
    const name = document.getElementById('chapter-name').value.trim();
    if (!name) {
        alert('Bitte gib einen Kapitelnamen ein.');
        return;
    }

    const chapter = {
        id: generateId(),
        name,
        createdAt: Date.now(),
        topics: parsedTopics
    };

    chapters.push(chapter);
    saveChapters();
    resetUpload();
    showView('dashboard');
}

function resetUpload() {
    parsedTopics = [];
    document.getElementById('drop-zone').style.display = 'block';
    document.getElementById('upload-preview').style.display = 'none';
    document.getElementById('file-input').value = '';
    document.getElementById('chapter-name').value = '';
    document.getElementById('topics-preview').innerHTML = '';
}

// --- Study Setup ---
function startStudySetup() {
    if (selectedChapterIds.length === 0) {
        alert('Bitte wähle mindestens ein Kapitel aus.');
        return;
    }

    const container = document.getElementById('setup-chapters');
    const selected = chapters.filter(c => selectedChapterIds.includes(c.id));

    container.innerHTML = selected.map(ch => `
        <div class="setup-chapter">
            <div class="setup-chapter-header">
                <div class="checkbox checked" onclick="toggleAllTopics('${ch.id}', this)"></div>
                <span>${escapeHtml(ch.name)}</span>
            </div>
            ${ch.topics.map(t => `
                <div class="setup-topic" onclick="toggleTopicCheck(this)">
                    <div class="checkbox checked" data-chapter="${ch.id}" data-topic="${t.id}"></div>
                    <div class="setup-topic-info">
                        <div class="setup-topic-name">${escapeHtml(t.name)}</div>
                        <div class="setup-topic-count">${t.cards.length} Karten</div>
                    </div>
                </div>
            `).join('')}
        </div>
    `).join('');

    showView('study-setup');
}

function toggleTopicCheck(topicEl) {
    const cb = topicEl.querySelector('.checkbox');
    cb.classList.toggle('checked');
}

function toggleAllTopics(chapterId, headerCheckbox) {
    headerCheckbox.classList.toggle('checked');
    const isChecked = headerCheckbox.classList.contains('checked');
    const checkboxes = document.querySelectorAll(`.checkbox[data-chapter="${chapterId}"]`);
    checkboxes.forEach(cb => {
        if (isChecked) cb.classList.add('checked');
        else cb.classList.remove('checked');
    });
}

// --- Study Session ---
function startStudy() {
    const selectedTopics = [];
    document.querySelectorAll('.setup-topic .checkbox.checked').forEach(cb => {
        const chId = cb.dataset.chapter;
        const tId = cb.dataset.topic;
        const chapter = chapters.find(c => c.id === chId);
        if (!chapter) return;
        const topic = chapter.topics.find(t => t.id === tId);
        if (!topic) return;
        selectedTopics.push({
            chapterId: chId,
            topicId: tId,
            topicName: topic.name,
            chapterName: chapter.name,
            cards: topic.cards.map(c => ({
                ...c,
                _chapterId: chId,
                _topicId: tId,
                _topicName: topic.name
            }))
        });
    });

    if (selectedTopics.length === 0) {
        alert('Bitte wähle mindestens ein Topic aus.');
        return;
    }

    const allCards = selectedTopics.flatMap(t => t.cards);
    shuffleArray(allCards);

    studySession = {
        queue: allCards,
        doneCards: [],
        totalCards: allCards.length,
        stats: { correct: 0, hard: 0, wrong: 0 },
        startTime: Date.now()
    };

    showView('study');
    showNextCard();
}

function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
}

function showNextCard() {
    updateStudyStats();

    if (studySession.queue.length === 0) {
        showStudyComplete();
        return;
    }

    const card = studySession.queue[0];
    studySession.currentCard = card;

    document.getElementById('study-card-area').style.display = 'block';
    document.getElementById('study-complete').style.display = 'none';

    document.getElementById('card-topic-label').textContent = card._topicName;
    document.getElementById('card-front-text').textContent = card.front;
    document.getElementById('card-back-text').textContent = card.back;

    const flashcard = document.getElementById('flashcard');
    flashcard.classList.remove('flipped');
    document.getElementById('card-buttons').style.display = 'none';
    document.getElementById('card-hint').style.display = 'block';
}

function flipCard() {
    const flashcard = document.getElementById('flashcard');
    if (!flashcard.classList.contains('flipped')) {
        flashcard.classList.add('flipped');
        document.getElementById('card-buttons').style.display = 'flex';
        document.getElementById('card-hint').style.display = 'none';
    }
}

function rateCard(rating) {
    const card = studySession.currentCard;
    if (!card) return;

    studySession.queue.shift();

    card.history.push(rating);
    studySession.stats[rating]++;

    const priority = getCardPriority(card.history);
    const insertPos = getInsertPosition(priority, studySession.queue.length);

    if (insertPos === -1) {
        studySession.doneCards.push(card);
    } else {
        studySession.queue.splice(insertPos, 0, card);
    }

    persistCardState(card);
    showNextCard();
}

function persistCardState(card) {
    const chapter = chapters.find(c => c.id === card._chapterId);
    if (!chapter) return;
    const topic = chapter.topics.find(t => t.id === card._topicId);
    if (!topic) return;
    const savedCard = topic.cards.find(c => c.id === card.id);
    if (!savedCard) return;

    savedCard.history = [...card.history];
    saveChapters();
}

function updateStudyStats() {
    if (!studySession) return;

    const remaining = studySession.queue.length;
    const done = studySession.doneCards.length;
    const total = studySession.totalCards;

    document.getElementById('stat-remaining').innerHTML = `Im Stapel: <strong>${remaining}</strong>`;
    document.getElementById('stat-done').innerHTML = `Fertig: <strong>${done}</strong>`;
    document.getElementById('stat-waiting').innerHTML = `Gesamt: <strong>${total}</strong>`;

    const progress = total > 0 ? Math.round((done / total) * 100) : 0;
    document.getElementById('progress-fill').style.width = `${progress}%`;
}

function showStudyComplete() {
    document.getElementById('study-card-area').style.display = 'none';
    document.getElementById('study-complete').style.display = 'block';

    const s = studySession.stats;
    document.getElementById('session-stats').innerHTML = `
        <div class="session-stat">
            <div class="session-stat-value correct">${s.correct}</div>
            <div class="session-stat-label">Richtig</div>
        </div>
        <div class="session-stat">
            <div class="session-stat-value hard">${s.hard}</div>
            <div class="session-stat-label">Schwer</div>
        </div>
        <div class="session-stat">
            <div class="session-stat-value wrong">${s.wrong}</div>
            <div class="session-stat-label">Falsch</div>
        </div>
    `;
}

function endStudy() {
    studySession = null;
    showView('dashboard');
}

// --- Utilities ---
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// --- Init ---
async function init() {
    currentUser = getUserFromUrl();

    if (!currentUser) {
        // Should not happen if accessed via /user/:name, but fallback
        document.getElementById('app').innerHTML = `
            <div style="text-align:center;padding:100px 20px;">
                <h1 style="color:#6c5ce7;">Zaras Lernprogramm</h1>
                <p style="color:#8b8fa3;margin:16px 0;">Bitte öffne die App über deinen persönlichen Link.</p>
                <p style="color:#8b8fa3;">z.B. <strong>/user/emma</strong></p>
            </div>`;
        return;
    }

    // Show user greeting
    document.getElementById('user-greeting').textContent =
        `Hallo ${currentUser.charAt(0).toUpperCase() + currentUser.slice(1)}! Wähle Kapitel zum Lernen aus oder lade neue Dateien hoch.`;

    await loadChapters();
    initUpload();
    renderDashboard();
}

document.addEventListener('DOMContentLoaded', init);
document.addEventListener('click', closeAllKebabs);
