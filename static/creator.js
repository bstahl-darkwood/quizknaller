// SmartQuiz - Quiz Creator

// State
let questions = [];
let currentQuizId = null;   // id des Quiz auf dem Server, wenn es schon gespeichert/geöffnet wurde

// Helper function to escape HTML to prevent XSS
function escapeHtml(text) {
    // Auch Anführungszeichen escapen – das Ergebnis landet teils in HTML-Attributen (value="…")
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// DOM Elements
const quizTitleInput = document.getElementById('quiz-title');
const questionCountDisplay = document.getElementById('question-count');
const questionsContainer = document.getElementById('questions-container');
const addQuestionBtn = document.getElementById('add-question-btn');
const saveLocalBtn = document.getElementById('save-local-btn');
const loadLocalBtn = document.getElementById('load-local-btn');
const downloadBtn = document.getElementById('download-btn');
const uploadInput = document.getElementById('upload-input');
const clearBtn = document.getElementById('clear-btn');
const toast = document.getElementById('toast');

// Initialize
init();

function init() {
    // Add event listeners
    addQuestionBtn.addEventListener('click', addQuestion);
    saveLocalBtn.addEventListener('click', saveToServer);
    loadLocalBtn.addEventListener('click', openSavedQuiz);
    downloadBtn.addEventListener('click', downloadAsJSON);
    uploadInput.addEventListener('change', handleFileUpload);
    clearBtn.addEventListener('click', clearAll);
    
    // Show empty state
    updateUI();

    // Von der Quiz-Auswahl aus „Bearbeiten“: /creator?id=…
    const id = new URLSearchParams(location.search).get('id');
    if (id) openQuizById(id);
}

// ---------- Eigene Quizze auf dem Server ----------
async function quizApi(path, options = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...options });
    if (res.status === 401) {
        location.href = '/login?next=' + encodeURIComponent('/creator');
        throw new Error('Bitte als Admin anmelden');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
    return data;
}

async function openQuizById(id) {
    try {
        const quiz = await quizApi(`/api/custom-quizzes/${encodeURIComponent(id)}`);
        loadQuizData(quiz);
        currentQuizId = quiz.id;
        showToast(`„${quiz.title}“ geöffnet – Änderungen mit „Auf dem Server speichern“ übernehmen.`, 'success');
    } catch (e) {
        showToast('Quiz konnte nicht geladen werden: ' + e.message, 'error');
    }
}

async function saveToServer() {
    if (!validateQuiz()) {
        return;
    }
    const quizData = getQuizData();
    try {
        const saved = await quizApi('/api/custom-quizzes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(currentQuizId ? { id: currentQuizId, ...quizData } : quizData),
        });
        currentQuizId = saved.id;
        // Adresse merken, damit Neuladen dasselbe Quiz wieder öffnet
        history.replaceState(null, '', `/creator?id=${encodeURIComponent(saved.id)}`);
        showToast('Auf dem Server gespeichert – steht jetzt auf jedem Rechner in der Quiz-Auswahl.', 'success');
    } catch (e) {
        showToast('Speichern fehlgeschlagen: ' + e.message, 'error');
    }
}

// Auswahl der gespeicherten Quizze (Dialog)
async function openSavedQuiz() {
    let list;
    try {
        list = await quizApi('/api/custom-quizzes');
    } catch (e) {
        showToast('Liste konnte nicht geladen werden: ' + e.message, 'error');
        return;
    }
    if (!list.length) {
        showToast('Auf dem Server liegen noch keine eigenen Quizze.', 'error');
        return;
    }
    let dialog = document.getElementById('open-quiz-dialog');
    if (!dialog) {
        dialog = document.createElement('dialog');
        dialog.id = 'open-quiz-dialog';
        dialog.className = 'confirm-dialog open-quiz-dialog';
        dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
        document.body.appendChild(dialog);
    }
    dialog.innerHTML = `
        <p class="confirm-message">Welches Quiz möchtest du öffnen?</p>
        <ul class="open-quiz-list">
            ${list.map(q => `<li><button type="button" data-id="${escapeHtml(q.id)}">
                <b>${escapeHtml(q.title)}</b><small>${q.questions.length} ${q.questions.length === 1 ? 'Frage' : 'Fragen'}</small></button></li>`).join('')}
        </ul>
        <div class="confirm-actions"><button type="button" class="confirm-cancel">Abbrechen</button></div>`;
    dialog.querySelector('.confirm-cancel').addEventListener('click', () => dialog.close());
    dialog.querySelectorAll('[data-id]').forEach(btn => btn.addEventListener('click', async () => {
        dialog.close();
        if (questions.length && !await SQ.confirm('Das geöffnete Quiz ersetzt den Inhalt des Formulars. Nicht gespeicherte Änderungen gehen verloren.', 'Öffnen')) return;
        await openQuizById(btn.dataset.id);
        history.replaceState(null, '', `/creator?id=${encodeURIComponent(btn.dataset.id)}`);
    }));
    dialog.showModal();
}

function addQuestion() {
    const question = {
        id: Date.now(),
        question: '',
        answers: ['', '', '', ''],
        correct: 0,
        time_limit: 20
    };
    
    questions.push(question);
    renderQuestion(question, questions.length - 1);
    updateUI();
    
    // Scroll to the new question
    setTimeout(() => {
        const newCard = document.querySelector(`[data-question-id="${question.id}"]`);
        if (newCard) {
            newCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }, 100);
}

function renderQuestion(question, index) {
    const questionCard = document.createElement('div');
    questionCard.className = 'question-card';
    questionCard.dataset.questionId = question.id;
    
    questionCard.innerHTML = `
        <div class="question-header">
            <span class="question-number">Frage ${index + 1}</span>
            <button class="btn-remove" type="button" data-remove="${question.id}">${SQ.icon('trash')} Löschen</button>
        </div>
        
        <div class="form-group">
            <label>Frage *</label>
            <textarea placeholder="Gib deine Frage ein..." data-field="question">${escapeHtml(question.question)}</textarea>
        </div>
        
        <div class="form-group">
            <label>Antworten * (Wähle die richtige Antwort)</label>
            <div class="answers-grid">
                ${question.answers.map((answer, i) => `
                    <div class="answer-input-group">
                        <input type="radio" name="correct-${question.id}" value="${i}" 
                            ${question.correct === i ? 'checked' : ''} 
                            data-field="correct">
                        <span class="answer-label">Antwort ${i + 1}:</span>
                        <input type="text" placeholder="Antwort eingeben..." 
                            value="${escapeHtml(answer)}" data-field="answer-${i}">
                    </div>
                `).join('')}
            </div>
        </div>
        
        <div class="form-group">
            <label>Zeitlimit (Sekunden) *</label>
            <div class="time-limit-group">
                <input type="number" min="5" max="120" value="${question.time_limit}" 
                    data-field="time_limit">
                <span>Sekunden</span>
            </div>
        </div>
    `;
    
    questionsContainer.appendChild(questionCard);
    
    // Add event listeners for this question
    attachQuestionListeners(questionCard, question.id);
}

function attachQuestionListeners(card, questionId) {
    const questionIndex = questions.findIndex(q => q.id === questionId);
    if (questionIndex === -1) return;
    
    // Question text
    const questionTextarea = card.querySelector('[data-field="question"]');
    questionTextarea.addEventListener('input', (e) => {
        questions[questionIndex].question = e.target.value;
    });
    
    // Answers
    for (let i = 0; i < 4; i++) {
        const answerInput = card.querySelector(`[data-field="answer-${i}"]`);
        answerInput.addEventListener('input', (e) => {
            questions[questionIndex].answers[i] = e.target.value;
        });
    }
    
    // Correct answer
    const correctRadios = card.querySelectorAll('[data-field="correct"]');
    correctRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            questions[questionIndex].correct = parseInt(e.target.value);
        });
    });
    
    // Time limit
    const timeLimitInput = card.querySelector('[data-field="time_limit"]');
    timeLimitInput.addEventListener('input', (e) => {
        questions[questionIndex].time_limit = parseInt(e.target.value);
    });
}

async function removeQuestion(questionId) {
    if (!await SQ.confirm('Möchtest du diese Frage wirklich löschen?', 'Löschen')) {
        return;
    }
    
    const index = questions.findIndex(q => q.id === questionId);
    if (index !== -1) {
        questions.splice(index, 1);
        updateUI();
    }
}

function updateUI() {
    questionCountDisplay.textContent = questions.length;
    
    // Clear and re-render all questions
    questionsContainer.innerHTML = '';
    
    if (questions.length === 0) {
        questionsContainer.innerHTML = `
            <div class="empty-state">
                <p>Noch keine Fragen vorhanden.</p>
                <p>Klicke auf "+ Frage hinzufügen", um zu starten!</p>
            </div>
        `;
    } else {
        questions.forEach((question, index) => {
            renderQuestion(question, index);
        });
    }
}

function validateQuiz() {
    if (!quizTitleInput.value.trim()) {
        showToast('Bitte gib einen Quiz-Titel ein!', 'error');
        quizTitleInput.focus();
        return false;
    }
    
    if (questions.length === 0) {
        showToast('Bitte füge mindestens eine Frage hinzu!', 'error');
        return false;
    }
    
    for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        
        if (!q.question.trim()) {
            showToast(`Frage ${i + 1}: Bitte gib einen Fragetext ein!`, 'error');
            return false;
        }
        
        for (let j = 0; j < 4; j++) {
            if (!q.answers[j].trim()) {
                showToast(`Frage ${i + 1}: Bitte fülle alle Antworten aus!`, 'error');
                return false;
            }
        }
        
        if (!Number.isInteger(q.time_limit) || q.time_limit < 5 || q.time_limit > 120) {
            showToast(`Frage ${i + 1}: Zeitlimit muss zwischen 5 und 120 Sekunden liegen!`, 'error');
            return false;
        }
    }
    
    return true;
}

function getQuizData() {
    return {
        title: quizTitleInput.value.trim(),
        questions: questions.map(q => ({
            question: q.question.trim(),
            answers: q.answers.map(a => a.trim()),
            correct: q.correct,
            time_limit: q.time_limit
        }))
    };
}

function downloadAsJSON() {
    if (!validateQuiz()) {
        return;
    }
    
    const quizData = getQuizData();
    
    // Create a quiz array with the single quiz (matching the quizzes.json format)
    const exportData = [quizData];
    
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `quiz_${quizData.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showToast('Quiz als JSON heruntergeladen.', 'success');
}

function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    
    reader.onload = async (e) => {
        try {
            const data = JSON.parse(e.target.result);
            
            // Check if it's an array (multiple quizzes) or single quiz
            let quizData;
            if (Array.isArray(data)) {
                if (data.length === 0) {
                    showToast('Die JSON-Datei enthält keine Quizze!', 'error');
                    return;
                }
                // Take the first quiz from the array
                quizData = data[0];
            } else {
                quizData = data;
            }
            
            // Validate structure
            if (!quizData.title || !Array.isArray(quizData.questions)) {
                showToast('Ungültiges Quiz-Format!', 'error');
                return;
            }
            
            // Validate each question
            for (let i = 0; i < quizData.questions.length; i++) {
                const q = quizData.questions[i];
                if (!q.question || 
                    !Array.isArray(q.answers) || 
                    q.answers.length !== 4 ||
                    typeof q.correct !== 'number' ||
                    q.correct < 0 || 
                    q.correct > 3 ||
                    typeof q.time_limit !== 'number' ||
                    q.time_limit < 5 ||
                    q.time_limit > 120) {
                    showToast(`Ungültiges Format bei Frage ${i + 1}!`, 'error');
                    return;
                }
            }
            
            if (!await SQ.confirm('Möchtest du dieses Quiz laden? Aktuelle Änderungen gehen verloren!', 'Laden')) {
                return;
            }
            
            loadQuizData(quizData);
            currentQuizId = null;   // importiert = neues Quiz, überschreibt nichts auf dem Server
            history.replaceState(null, '', '/creator');
            showToast('Quiz importiert – mit „Auf dem Server speichern“ übernehmen.', 'success');
        } catch (e) {
            showToast('Fehler beim Lesen der Datei: ' + e.message, 'error');
        }
    };
    
    reader.readAsText(file);
    
    // Reset file input
    event.target.value = '';
}

function loadQuizData(quizData) {
    quizTitleInput.value = quizData.title;
    
    questions = quizData.questions.map((q, index) => ({
        id: Date.now() + index,
        question: String(q.question || ''),
        answers: q.answers.map(a => String(a || '')),
        correct: parseInt(q.correct) || 0,
        time_limit: parseInt(q.time_limit) || 20
    }));
    
    updateUI();
}

async function clearAll() {
    if (!await SQ.confirm('Formular leeren und ein neues Quiz beginnen? Auf dem Server gespeicherte Quizze bleiben erhalten.', 'Formular leeren')) {
        return;
    }
    
    quizTitleInput.value = '';
    questions = [];
    currentQuizId = null;   // sonst würde das nächste Speichern das zuletzt geöffnete Quiz überschreiben
    history.replaceState(null, '', '/creator');
    updateUI();
    showToast('Formular geleert.', 'success');
}

function showToast(message, type = 'success') {
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    
    setTimeout(() => {
        toast.className = 'toast';
    }, 3000);
}

// Löschen-Knöpfe der Fragen: Event-Delegation statt onclick-Attribut (die Content-Security-Policy
// erlaubt keine Inline-Handler)
questionsContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (btn) removeQuestion(Number(btn.dataset.remove));
});
