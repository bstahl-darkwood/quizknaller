// SmartQuiz - Player Client
const socket = io();

// Configuration
const AUTOPLAY_COUNTDOWN_SECONDS = 10;

let gameCode = null;
let timeLimit = 20;
let timerInterval = null;
let autoplayCountdownInterval = null;

// DOM Elements
const screens = {
    join: document.getElementById('join-screen'),
    team: document.getElementById('team-screen'),
    waiting: document.getElementById('waiting-screen'),
    starting: document.getElementById('starting-screen'),
    question: document.getElementById('question-screen'),
    answered: document.getElementById('answered-screen'),
    result: document.getElementById('result-screen'),
    final: document.getElementById('final-screen'),
    poll: document.getElementById('poll-screen'),
    pollResult: document.getElementById('poll-result-screen')
};

const elements = {
    gameCodeInput: document.getElementById('game-code'),
    playerNameInput: document.getElementById('player-name'),
    joinBtn: document.getElementById('join-btn'),
    errorMessage: document.getElementById('error-message'),
    teamList: document.getElementById('team-list'),
    waitingQuizTitle: document.getElementById('waiting-quiz-title'),
    startCountdown: document.getElementById('start-countdown'),
    questionNumber: document.getElementById('question-number'),
    timerFill: document.getElementById('timer-fill'),
    questionText: document.getElementById('question-text'),
    answersGrid: document.getElementById('answers-grid'),
    resultIcon: document.getElementById('result-icon'),
    resultTitle: document.getElementById('result-title'),
    correctAnswer: document.getElementById('correct-answer'),
    scoreGained: document.getElementById('score-gained'),
    totalScore: document.getElementById('total-score'),
    rankDisplay: document.getElementById('rank-display'),
    streakDisplay: document.getElementById('streak-display'),
    resultScreen: document.getElementById('result-screen'),
    finalRank: document.getElementById('final-rank'),
    finalScore: document.getElementById('final-score'),
    playAgainBtn: document.getElementById('play-again-btn'),
    playerAutoplayCountdown: document.getElementById('player-autoplay-countdown'),
    playerAutoplayTimer: document.getElementById('player-autoplay-timer'),
    playerAutoplayMessage: document.getElementById('player-autoplay-message'),
    hostDisconnectOverlay: document.getElementById('host-disconnect-overlay'),
    hostReconnectTimer: document.getElementById('host-reconnect-timer'),
    joinForm: document.getElementById('join-form'),
    questionPhase: document.getElementById('question-phase'),
    questionCard: document.querySelector('.question-card'),
    connectionToast: document.getElementById('connection-toast')
};

let hostReconnectCountdownInterval = null;

// Helper functions
function showScreen(screenName) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[screenName].classList.add('active');
    document.body.dataset.screen = screenName;   // z. B. Lichterkette während der Frage ausblenden
}

function showError(message) {
    elements.errorMessage.textContent = message;
    elements.errorMessage.classList.add('show');
    setTimeout(() => elements.errorMessage.classList.remove('show'), 4500);
}

// ---------- Handy-Helfer ----------
// Kurzes Vibrieren (Android). iOS-Browser unterstützen das nicht – dort passiert einfach nichts.
function vibrate(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* ignorieren */ }
}

// Bildschirm während des Spiels anlassen (iOS ab 16.4, Android Chrome)
let wakeLock = null;
async function keepScreenOn() {
    if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { /* z. B. Energiesparmodus – dann eben ohne */ }
}
function releaseScreen() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && gameCode) keepScreenOn();
});

// Zurück-Taste (Android) / Wischgeste: nicht versehentlich das laufende Spiel verlassen
let backGuardActive = false;
function armBackGuard() {
    if (backGuardActive) return;
    backGuardActive = true;
    history.pushState({ smartquiz: true }, '');
}
window.addEventListener('popstate', async () => {
    if (!backGuardActive) return;
    backGuardActive = false;
    if (gameCode && !screens.join.classList.contains('active')) {
        if (await SQ.confirm('Spiel wirklich verlassen?', 'Verlassen')) {
            leaveGame();
        } else {
            armBackGuard();
        }
    }
});

function clearSession() {
    localStorage.removeItem('playerGameCode');
    localStorage.removeItem('playerName');
    localStorage.removeItem('playerQuizTitle');
    localStorage.removeItem('playerToken');
}

function leaveGame() {
    gameCode = null;
    clearSession();
    releaseScreen();
    elements.gameCodeInput.value = '';
    elements.playerNameInput.value = '';
    showScreen('join');
}

function enteredGame() {
    keepScreenOn();
    armBackGuard();
}

// Event Listeners
elements.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    soundManager.init();
    const code = elements.gameCodeInput.value.trim().toUpperCase();
    const name = elements.playerNameInput.value.trim();

    // Enter im Code-Feld: weiter zum Namen statt Fehlermeldung
    if (document.activeElement === elements.gameCodeInput && code && !name) {
        elements.playerNameInput.focus();
        return;
    }

    if (!code || code.length < 4) {
        showError('Bitte gib einen gültigen Spiel-Code ein');
        elements.gameCodeInput.focus();
        return;
    }

    if (!name) {
        showError('Bitte gib deinen Namen ein');
        elements.playerNameInput.focus();
        return;
    }

    elements.playerNameInput.blur();   // Tastatur schließen
    socket.emit('join_game', { code, name });
});

// Code-Feld: nur Buchstaben/Ziffern, groß
elements.gameCodeInput.addEventListener('input', () => {
    const cleaned = elements.gameCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (cleaned !== elements.gameCodeInput.value) elements.gameCodeInput.value = cleaned;
});

// Answer buttons
document.querySelectorAll('.answer-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (btn.classList.contains('disabled')) return;
        
        // Initialize sound on first user interaction
        soundManager.init();
        
        const answerIndex = parseInt(btn.dataset.index);
        socket.emit('submit_answer', { code: gameCode, answer: answerIndex });
        
        // Play pop sound when answer is submitted
        soundManager.playPopSound().catch(() => {}); // Silently ignore sound errors
        
        vibrate(15);

        // Disable all buttons and mark selected
        document.querySelectorAll('.answer-btn').forEach(b => {
            b.classList.add('disabled');
            if (b === btn) b.classList.add('selected');
        });
    });
});

elements.playAgainBtn.addEventListener('click', () => {
    leaveGame();
});

// Socket Events
socket.on('error', (data) => {
    showError(data.message);
    
    // If game not found, clear localStorage so we don't keep trying to reconnect
    if (data.message && (data.message.includes('nicht gefunden') || data.message.includes('not found'))) {
        localStorage.removeItem('playerGameCode');
        localStorage.removeItem('playerQuizTitle');
        localStorage.removeItem('playerToken');
    }
});

// Handle host disconnection
socket.on('host_disconnected', (data) => {
    const gracePeriod = data.grace_period || 60;
    let countdown = gracePeriod;
    
    if (elements.hostDisconnectOverlay && elements.hostReconnectTimer) {
        elements.hostReconnectTimer.textContent = countdown;
        elements.hostDisconnectOverlay.style.display = 'flex';
        
        // Clear any existing countdown
        if (hostReconnectCountdownInterval) {
            clearInterval(hostReconnectCountdownInterval);
        }
        
        hostReconnectCountdownInterval = setInterval(() => {
            countdown--;
            elements.hostReconnectTimer.textContent = countdown;
            
            if (countdown <= 0) {
                clearInterval(hostReconnectCountdownInterval);
                hostReconnectCountdownInterval = null;
            }
        }, 1000);
    }
});

// Handle host reconnection
socket.on('host_reconnected', (data) => {
    if (hostReconnectCountdownInterval) {
        clearInterval(hostReconnectCountdownInterval);
        hostReconnectCountdownInterval = null;
    }
    
    if (elements.hostDisconnectOverlay) {
        elements.hostDisconnectOverlay.style.display = 'none';
    }
});

// Try to reconnect on page load or auto-fill code from URL
window.addEventListener('load', () => {
    // Check for game code in URL (from QR code scan)
    const urlParams = new URLSearchParams(window.location.search);
    const codeFromUrl = urlParams.get('code');
    
    if (codeFromUrl) {
        elements.gameCodeInput.value = codeFromUrl.toUpperCase();
        // Pre-fill name if we have it saved
        const savedName = localStorage.getItem('playerName');
        if (savedName) {
            elements.playerNameInput.value = savedName;
        }
        // Focus on name input since code is already filled
        elements.playerNameInput.focus();
        // Clear the URL parameter without reloading the page
        window.history.replaceState({}, document.title, window.location.pathname);
        // Don't try to reconnect if coming from QR code - let user enter their name
        return;
    }
    
    // Try to reconnect if we have saved session (only if not from QR code)
    const savedGameCode = localStorage.getItem('playerGameCode');
    const savedPlayerName = localStorage.getItem('playerName');
    if (savedGameCode && savedPlayerName) {
        // Pre-fill the inputs for visual feedback
        elements.gameCodeInput.value = savedGameCode;
        elements.playerNameInput.value = savedPlayerName;
        socket.emit('reconnect_player', { code: savedGameCode, name: savedPlayerName, token: localStorage.getItem('playerToken') });
    }
});

// Socket.IO verbindet nach Netzabbrüchen (Standby, WLAN-Wechsel) automatisch neu – aber mit neuer ID.
// Dann beim Server wieder anmelden, sonst bekommt der Spieler keine Fragen mehr.
let hasConnectedOnce = false;
let toastTimer = null;
socket.on('disconnect', () => {
    // Kurz warten – ein Blinzeln der Verbindung soll keinen Hinweis auslösen
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        if (gameCode) elements.connectionToast.classList.add('show');
    }, 1200);
});
socket.on('connect', () => {
    clearTimeout(toastTimer);
    elements.connectionToast.classList.remove('show');
    if (!hasConnectedOnce) {
        hasConnectedOnce = true;
        return; // Erste Verbindung: das übernimmt der load-Handler
    }
    const savedGameCode = localStorage.getItem('playerGameCode');
    const savedPlayerName = localStorage.getItem('playerName');
    if (savedGameCode && savedPlayerName) {
        socket.emit('reconnect_player', { code: savedGameCode, name: savedPlayerName, token: localStorage.getItem('playerToken') });
    }
});

// Reconnection handlers
socket.on('reconnected_player', (data) => {
    gameCode = data.code;
    if (data.player_token) localStorage.setItem('playerToken', data.player_token);
    if (data.name) localStorage.setItem('playerName', data.name);
    localStorage.setItem('playerGameCode', data.code);
    elements.playerNameInput.value = localStorage.getItem('playerName');
    elements.waitingQuizTitle.textContent = SQ.plain(data.quiz_title);
    enteredGame();
    
    // Restore to appropriate screen based on state
    if (data.state === 'lobby') {
        if (data.team_mode && data.teams && data.teams.length > 0 && !data.team) {
            showTeamSelection(data.teams);
        } else {
            showScreen('waiting');
        }
    } else if (data.state === 'starting') {
        showScreen('starting');
    } else if (data.state === 'question' || data.state === 'reading') {
        showScreen('question');
    } else if (data.state === 'results') {
        showScreen('answered');
    } else if (data.state === 'ended') {
        showScreen('final');
    }
});

socket.on('reconnect_failed', (data) => {
    clearSession();
    showError(data.message || 'Verbindung fehlgeschlagen');
    showScreen('join');
});

socket.on('joined_game', (data) => {
    gameCode = data.code;
    // Save to localStorage for reconnection
    localStorage.setItem('playerGameCode', data.code);
    localStorage.setItem('playerName', elements.playerNameInput.value.trim());
    localStorage.setItem('playerQuizTitle', data.quiz_title);
    if (data.player_token) localStorage.setItem('playerToken', data.player_token);
    
    elements.waitingQuizTitle.textContent = SQ.plain(data.quiz_title);
    enteredGame();
    vibrate(20);
    
    // If team mode is enabled, show team selection
    if (data.team_mode && data.teams && data.teams.length > 0) {
        showTeamSelection(data.teams);
    } else {
        showScreen('waiting');
    }
});

socket.on('quiz_switched', (data) => {
    // gameCode must be restored here, otherwise answers/team picks are sent with code=null
    gameCode = data.code;
    localStorage.setItem('playerGameCode', data.code);
    const name = elements.playerNameInput.value.trim();
    if (name) localStorage.setItem('playerName', name);
    localStorage.setItem('playerQuizTitle', data.quiz_title);

    elements.waitingQuizTitle.textContent = SQ.plain(data.quiz_title);

    if (data.team_mode && data.teams && data.teams.length > 0 && !data.team) {
        showTeamSelection(data.teams);
    } else {
        showScreen('waiting');
    }
});

function showTeamSelection(teams) {
    elements.teamList.innerHTML = '';
    teams.forEach(team => {
        const teamBtn = document.createElement('button');
        teamBtn.className = 'team-btn';
        teamBtn.textContent = team;
        teamBtn.addEventListener('click', () => {
            socket.emit('select_team', { code: gameCode, team: team });
            showScreen('waiting');
        });
        elements.teamList.appendChild(teamBtn);
    });
    showScreen('team');
}

socket.on('team_config_updated', (data) => {
    // If team mode was enabled after joining, show team selection
    if (data.team_mode && data.teams && data.teams.length > 0) {
        if (screens.waiting.classList.contains('active')) {
            showTeamSelection(data.teams);
        }
    }
});

socket.on('game_starting', () => {
    showScreen('starting');
    let count = 3;
    elements.startCountdown.textContent = count;
    
    // Play countdown tick sound
    soundManager.playCountdownTick().catch(() => {}); // Silently ignore sound errors
    
    const countdownInterval = setInterval(() => {
        count--;
        if (count > 0) {
            elements.startCountdown.textContent = count;
            soundManager.playCountdownTick().catch(() => {}); // Silently ignore sound errors
        } else {
            clearInterval(countdownInterval);
            soundManager.playCountdownFinal().catch(() => {}); // Silently ignore sound errors
        }
    }, 1000);
});

// Reading phase - show question only
socket.on('show_question_reading', (data) => {
    // Clear previous state
    if (timerInterval) clearInterval(timerInterval);
    
    elements.questionNumber.textContent = `${data.question_num}/${data.total_questions}`;
    elements.questionText.textContent = data.question;
    elements.questionCard.classList.toggle('long', data.question.length > 110);
    elements.questionPhase.textContent = 'Lesen …';
    
    // Hide answer buttons during reading phase
    const buttons = document.querySelectorAll('.answer-btn');
    buttons.forEach(btn => {
        btn.querySelector('.answer-label').textContent = '';
        btn.classList.add('hidden');
        btn.classList.remove('disabled', 'selected');
    });
    
    // Show reading indicator in timer bar
    elements.timerFill.style.width = '100%';
    elements.timerFill.classList.remove('warning', 'danger');
    elements.timerFill.classList.add('reading');
    
    showScreen('question');
    
    // Animate reading countdown
    let readingTimeLeft = data.reading_time;
    timerInterval = setInterval(() => {
        readingTimeLeft -= 0.1;
        const percent = (readingTimeLeft / data.reading_time) * 100;
        elements.timerFill.style.width = `${percent}%`;
        
        if (readingTimeLeft <= 0) {
            clearInterval(timerInterval);
        }
    }, 100);
});

// Antworten eintragen; lange Texte -> Listenansicht, damit auf kleinen Handys nichts abgeschnitten wird
function setAnswers(answers) {
    const buttons = document.querySelectorAll('.answer-btn');
    const longest = Math.max(...answers.map(a => String(a).length));
    elements.answersGrid.classList.toggle('list', longest > 26);
    answers.forEach((answer, i) => {
        buttons[i].querySelector('.answer-label').textContent = answer;
        buttons[i].classList.remove('hidden', 'disabled', 'selected');
    });
}

// Show answers after reading phase
socket.on('show_answers', (data) => {
    // Clear reading timer
    if (timerInterval) clearInterval(timerInterval);
    
    timeLimit = data.time_limit;
    
    // Reveal answer buttons
    setAnswers(data.answers);
    elements.questionPhase.textContent = 'Jetzt antworten!';
    vibrate(10);
    
    // Reset and start answer timer
    elements.timerFill.style.width = '100%';
    elements.timerFill.classList.remove('warning', 'danger', 'reading');
    
    // Nach einem Reconnect schickt der Server die Restzeit mit
    let timeLeft = typeof data.time_left === 'number' ? data.time_left : timeLimit;
    showScreen('question');
    timerInterval = setInterval(() => {
        timeLeft -= 0.1;
        const percent = (timeLeft / timeLimit) * 100;
        elements.timerFill.style.width = `${percent}%`;
        
        if (percent < 25) {
            elements.timerFill.classList.add('danger');
            elements.timerFill.classList.remove('warning');
        } else if (percent < 50) {
            elements.timerFill.classList.add('warning');
        }
        
        if (timeLeft <= 0) {
            clearInterval(timerInterval);
        }
    }, 100);
});

// Legacy handler for backwards compatibility
socket.on('show_question', (data) => {
    // Clear previous state
    if (timerInterval) clearInterval(timerInterval);
    
    elements.questionNumber.textContent = `${data.question_num}/${data.total_questions}`;
    elements.questionText.textContent = data.question;
    timeLimit = data.time_limit;
    
    // Set up answer buttons
    setAnswers(data.answers);
    
    // Reset and start timer
    elements.timerFill.style.width = '100%';
    elements.timerFill.classList.remove('warning', 'danger', 'reading');
    
    showScreen('question');
    
    let timeLeft = timeLimit;
    timerInterval = setInterval(() => {
        timeLeft -= 0.1;
        const percent = (timeLeft / timeLimit) * 100;
        elements.timerFill.style.width = `${percent}%`;
        
        if (percent < 25) {
            elements.timerFill.classList.add('danger');
            elements.timerFill.classList.remove('warning');
        } else if (percent < 50) {
            elements.timerFill.classList.add('warning');
        }
        
        if (timeLeft <= 0) {
            clearInterval(timerInterval);
        }
    }, 100);
});

socket.on('answer_received', () => {
    if (timerInterval) clearInterval(timerInterval);
    showScreen('answered');
});

socket.on('your_result', (data) => {
    if (timerInterval) clearInterval(timerInterval);
    if (autoplayCountdownInterval) clearInterval(autoplayCountdownInterval);
    
    // Hide autoplay countdown initially
    if (elements.playerAutoplayCountdown) {
        elements.playerAutoplayCountdown.style.display = 'none';
    }
    
    if (data.correct) {
        elements.resultScreen.classList.remove('incorrect');
        elements.resultScreen.classList.add('correct');
        elements.resultIcon.innerHTML = SQ.icon('check');
        elements.resultTitle.textContent = 'Richtig!';
        vibrate([30, 40, 30]);
        // Play success sound for correct answer
        soundManager.playSuccessSound().catch(() => {}); // Silently ignore sound errors
    } else {
        elements.resultScreen.classList.remove('correct');
        elements.resultScreen.classList.add('incorrect');
        elements.resultIcon.innerHTML = SQ.icon('x');
        elements.resultTitle.textContent = 'Leider falsch';
        vibrate(120);
        // Play error sound for incorrect answer
        soundManager.playErrorSound().catch(() => {}); // Silently ignore sound errors
    }
    
    elements.correctAnswer.textContent = `Richtige Antwort: ${data.correct_answer}`;
    elements.scoreGained.textContent = data.score_gained > 0 ? `+ ${data.score_gained.toLocaleString('de-DE')} Punkte` : 'keine Punkte';
    elements.totalScore.textContent = Number(data.total_score).toLocaleString('de-DE');
    elements.rankDisplay.textContent = `${data.rank}.`;
    elements.streakDisplay.innerHTML = data.streak > 1 ? `${SQ.icon('flame', 'streak-icon')}${data.streak}` : '–';
    
    showScreen('result');
});

// Handle autoplay countdown from host
socket.on('autoplay_countdown', (data) => {
    if (elements.playerAutoplayCountdown && elements.playerAutoplayTimer) {
        let countdown = data.seconds || AUTOPLAY_COUNTDOWN_SECONDS;
        elements.playerAutoplayTimer.textContent = countdown;
        
        // Set message based on whether this is the last question
        if (elements.playerAutoplayMessage) {
            if (data.is_last_question) {
                elements.playerAutoplayMessage.textContent = 'Ergebnisse in';
            } else {
                elements.playerAutoplayMessage.textContent = 'Nächste Frage in';
            }
        }
        
        elements.playerAutoplayCountdown.style.display = 'block';
        
        if (autoplayCountdownInterval) clearInterval(autoplayCountdownInterval);
        
        autoplayCountdownInterval = setInterval(() => {
            countdown--;
            elements.playerAutoplayTimer.textContent = countdown;
            
            if (countdown <= 0) {
                clearInterval(autoplayCountdownInterval);
                autoplayCountdownInterval = null;
                elements.playerAutoplayCountdown.style.display = 'none';
            }
        }, 1000);
    }
});

socket.on('game_ended', (data) => {
    if (timerInterval) clearInterval(timerInterval);
    if (autoplayCountdownInterval) {
        clearInterval(autoplayCountdownInterval);
        autoplayCountdownInterval = null;
    }
    
    if (data.reason || data.message || !data.leaderboard) {
        // Game aborted (host ended it, host gone, or removed for inactivity)
        leaveGame();
        showError(data.reason || data.message || 'Das Spiel wurde beendet.');
        return;
    }
    
    // Normal end: keep the session - the host may start another quiz with the same players
    const leaderboard = data.leaderboard;
    const myName = elements.playerNameInput.value.trim();
    const myRank = leaderboard.findIndex(p => p.name.toLowerCase() === myName.toLowerCase()) + 1;
    const myScore = leaderboard.find(p => p.name.toLowerCase() === myName.toLowerCase())?.score || 0;
    const myTeam = leaderboard.find(p => p.name.toLowerCase() === myName.toLowerCase())?.team;
    
    // Platz als Zahl; Platz 1 mit Krone statt bunter Medaillen-Emojis
    const rankHtml = myRank === 1 ? `${SQ.icon('crown', 'final-crown')}1.` : `${myRank}.`;
    
    let finalText = `${Number(myScore).toLocaleString('de-DE')} Punkte`;
    if (data.team_mode && myTeam) {
        finalText += ` (Team: ${myTeam})`;
    }
    
    elements.finalRank.innerHTML = rankHtml;
    elements.finalScore.textContent = finalText;
    releaseScreen();
    vibrate([40, 60, 40, 60, 80]);
    
    showScreen('final');
});

// ---------- Abstimmung (z. B. bestes Lebkuchenhaus) ----------
let poll = null;   // { title, options, state, my_vote, results }

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderPoll() {
    document.getElementById('poll-title').textContent = poll.title;
    const status = document.getElementById('poll-status');
    const voted = poll.my_vote !== null && poll.my_vote !== undefined;
    status.classList.toggle('saved', poll.state === 'open' && voted);
    if (poll.state === 'lobby') {
        status.textContent = 'Gleich geht’s los – sobald der Host startet, kannst du hier abstimmen.';
    } else if (voted) {
        status.textContent = 'Deine Stimme ist gespeichert. Bis zum Ende kannst du sie noch ändern.';
    } else {
        status.textContent = 'Tippe auf deinen Favoriten.';
    }
    const list = document.getElementById('poll-options');
    list.classList.toggle('locked', poll.state !== 'open');
    list.innerHTML = poll.options.map((o, i) => `
        <button type="button" class="poll-option${poll.my_vote === i ? ' selected' : ''}" data-index="${i}"
                aria-pressed="${poll.my_vote === i}">
            <span class="num">${i + 1}</span>
            <span class="txt">${escapeHtml(o.name)}${o.detail ? `<small>${escapeHtml(o.detail)}</small>` : ''}</span>
            <span class="tick">${SQ.icon('check')}</span>
        </button>`).join('');
}

function renderPollResult() {
    const r = poll.results;
    const winners = r.ranking.filter(row => r.winners.includes(row.index));
    const kicker = document.getElementById('poll-result-kicker');
    const winnerEl = document.getElementById('poll-winner');
    const detailEl = document.getElementById('poll-winner-detail');
    const votesEl = document.getElementById('poll-winner-votes');
    if (r.total_votes === 0) {
        kicker.textContent = 'Abstimmung beendet';
        winnerEl.textContent = 'Keine Stimmen';
        detailEl.textContent = '';
        votesEl.textContent = '';
    } else {
        kicker.textContent = winners.length > 1 ? 'Gleichstand! Gewonnen haben' : 'Gewonnen hat';
        winnerEl.textContent = winners.map(w => w.name).join(' & ');
        detailEl.textContent = winners.length === 1 ? (winners[0].detail || '') : '';
        const v = winners[0].votes;
        votesEl.textContent = `${v} ${v === 1 ? 'Stimme' : 'Stimmen'}`;
    }
    const mine = poll.my_vote !== null && poll.my_vote !== undefined ? poll.options[poll.my_vote] : null;
    const myRow = mine ? r.ranking.find(row => row.index === poll.my_vote) : null;
    document.getElementById('poll-mine').textContent = mine
        ? (r.winners.includes(poll.my_vote)
            ? `Du hast für „${mine.name}“ gestimmt – dein Favorit hat gewonnen!`
            : `Du hast für „${mine.name}“ gestimmt (Platz ${myRow.place}).`)
        : 'Du hast nicht abgestimmt.';
    releaseScreen();
    showScreen('pollResult');
}

function showPoll() {
    if (poll.state === 'closed' && poll.results) {
        renderPollResult();
    } else {
        renderPoll();
        showScreen('poll');
    }
}

socket.on('poll_joined', (data) => {
    gameCode = data.code;
    localStorage.setItem('playerGameCode', data.code);
    localStorage.setItem('playerName', data.name);
    localStorage.setItem('playerToken', data.player_token);
    elements.playerNameInput.value = data.name;
    poll = { title: data.title, options: data.options, state: data.state, my_vote: data.my_vote, results: data.results };
    enteredGame();
    vibrate(20);
    showPoll();
});

socket.on('poll_options', (data) => {
    if (!poll) return;
    poll.title = data.title;
    poll.options = data.options;
    if (poll.my_vote !== null && poll.my_vote >= poll.options.length) poll.my_vote = null;
    renderPoll();
});

socket.on('poll_state', (data) => {
    if (!poll) return;
    poll.state = data.state;
    if (data.results) poll.results = data.results;
    if (data.state === 'open') vibrate([30, 50, 30]);
    if (data.state === 'closed') vibrate([40, 60, 40, 60, 80]);
    showPoll();
});

socket.on('vote_saved', (data) => {
    if (!poll) return;
    poll.my_vote = data.option;
    renderPoll();
});

socket.on('poll_deleted', (data) => {
    poll = null;
    leaveGame();
    showError(data.message || 'Die Abstimmung wurde beendet.');
});

document.getElementById('poll-options').addEventListener('click', (e) => {
    const btn = e.target.closest('.poll-option');
    if (!btn || !poll) return;
    soundManager.init();
    if (poll.state !== 'open') {
        const status = document.getElementById('poll-status');
        status.classList.remove('nudge');
        void status.offsetWidth;   // Animation neu starten
        status.classList.add('nudge');
        vibrate([10, 40, 10]);
        return;
    }
    const index = parseInt(btn.dataset.index, 10);
    if (index === poll.my_vote) return;
    // Sofort markieren, der Server bestätigt mit vote_saved
    document.querySelectorAll('.poll-option').forEach(b => b.classList.toggle('selected', b === btn));
    socket.emit('cast_vote', { code: gameCode, option: index });
    soundManager.playPopSound().catch(() => {});
    vibrate(15);
});

document.getElementById('poll-leave-btn').addEventListener('click', () => {
    poll = null;
    leaveGame();
});

// Prevent zoom on double tap, but allow input fields to work properly
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
    // Allow input fields to work normally (shows keyboard)
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        return;
    }
    
    const now = Date.now();
    if (now - lastTouchEnd <= 300) {
        e.preventDefault();
    }
    lastTouchEnd = now;
}, { passive: false });
