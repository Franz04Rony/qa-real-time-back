require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

app.get('/', (req, res) => {
    res.send("servidor corriendo!");
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Load Data
const questionsPath = path.join(__dirname, 'data', 'questions.txt');
const punishmentsPath = path.join(__dirname, 'data', 'punishments.txt');

function readLines(filePath) {
    try {
        const data = fs.readFileSync(filePath, 'utf-8');
        return data.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    } catch (err) {
        console.error(`Error reading ${filePath}:`, err);
        return ["Pregunta por defecto?"];
    }
}

const ALL_QUESTIONS = readLines(questionsPath);
const ALL_PUNISHMENTS = readLines(punishmentsPath);

console.log(`Loaded ${ALL_QUESTIONS.length} questions and ${ALL_PUNISHMENTS.length} punishments.`);

// Global Game State (Single Room 'default' for simplicity as per requirements for 2 people)
let gameState = {
    players: {}, // { socketId: { id, name, score, avatar? } }
    status: 'LOBBY', // LOBBY, QUESTION, VOTING, PUNISHMENT, RESULTS
    round: 0,
    maxRounds: 10,
    currentQuestion: "",
    currentQuestionIndex: -1,
    currentPunishment: "",
    answers: {}, // { socketId: text }
    votes: {}, // { socketId: boolean } (true = correct, false = incorrect)
    ready: {}, // { socketId: boolean }
    punishmentLosers: [], // List of socketIds who lost the round
    punishmentDone: [], // List of socketIds who finished punishment
    timer: 0,
    timerInterval: null
};

// Utils
function getRandomSubset(array, count) {
    const shuffled = [...array].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
}

function broadcastState() {

    io.emit('game_state', {
        players: gameState.players,
        status: gameState.status,
        round: gameState.round,
        maxRounds: gameState.maxRounds,
        currentQuestion: gameState.currentQuestion,
        currentPunishment: gameState.currentPunishment,
        answers: gameState.answers,
        votes: gameState.votes, // Be careful sharing this before reveal? Actually requirement says "show answers" then vote.
        punishmentLosers: gameState.punishmentLosers
    });
}

function startTimer(seconds, callback) {
    clearInterval(gameState.timerInterval);
    gameState.timer = seconds;
    io.emit('timer_update', gameState.timer);

    gameState.timerInterval = setInterval(() => {
        gameState.timer--;
        io.emit('timer_update', gameState.timer);
        if (gameState.timer <= 0) {
            clearInterval(gameState.timerInterval);
            if (callback) callback();
        }
    }, 1000);
}

function nextRound() {
    if (gameState.round >= gameState.maxRounds) {
        gameState.status = 'RESULTS';
        broadcastState();
        return;
    }

    gameState.round++;
    gameState.status = 'QUESTION';
    gameState.answers = {};
    gameState.votes = {};
    gameState.ready = {};

    // Pick sequential from game subset
    const qIndex = gameState.round - 1;
    if (qIndex < gameState.gameQuestions.length) {
        gameState.currentQuestion = gameState.gameQuestions[qIndex].replace('{USER}', 'la otra persona');
    } else {
        gameState.currentQuestion = "Ronda Extra (Sin pregunta definida)";
    }

    broadcastState();

    // Timer for question (e.g. 60s)
    startTimer(60, () => {
        // Time up, go to voting
        evaluateVotingPhase();
    });
}

function evaluateVotingPhase() {
    gameState.status = 'VOTING';
    broadcastState();
    // No timer for voting described, but better to have one or wait for both.
    // Requirement: "votar si la respuesta... es correcta o no".
}

function evaluatePunishmentOrNext() {
    const pIds = Object.keys(gameState.players);
    if (pIds.length < 2) return; // Should not happen

    const p1 = pIds[0];
    const p2 = pIds[1];

    // Check votes
    // Player 1 voted on Player 2's answer
    // Player 2 voted on Player 1's answer
    // If P1 says P2 is correct, P2 gets point.

    let losers = [];

    // Vote Logic:
    // votes[p1] is the validation P1 gave to P2's answer? Or votes[p1] is if P1's answer was correct?
    // Requirement: "Si la otra persona vota que tu respuesta es correcta, ganas 1 punto"
    // implies P1 votes on P2's answer.
    // Let's store votes as: votes: { voterId: boolean } (Is the OTHER person correct?)
    // This is ambiguous. Let's make it structured: votes: { voterId: { targetId: boolean } } or just simplified for 2 players.
    // Simplified: votes[player_who_voted] = true/false (meaning "The other person was correct")

    const p1Vote = gameState.votes[p1]; // P1 thinks P2 is...
    const p2Vote = gameState.votes[p2]; // P2 thinks P1 is...

    let p1Correct = p2Vote === true; // P1 is correct if P2 said so
    let p2Correct = p1Vote === true;

    if (p1Correct) gameState.players[p1].score++;
    if (p2Correct) gameState.players[p2].score++;

    if (!p1Correct) losers.push(p1);
    if (!p2Correct) losers.push(p2);

    if (losers.length > 0) {
        gameState.punishmentLosers = losers;
        gameState.status = 'PUNISHMENT';

        // Pick random from game subset (or sequential if we want unique punishments per game)
        // Let's pick random from the subset to keep it unpredictable but from the selected pool
        const pIndex = Math.floor(Math.random() * gameState.gamePunishments.length);
        gameState.currentPunishment = gameState.gamePunishments[pIndex];

        gameState.punishmentDone = [];
        broadcastState();
    } else {
        // No losers, next round
        nextRound();
    }
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join_game', (nickname) => {
        if (Object.keys(gameState.players).length >= 2) {
            socket.emit('error', 'Game full');
            return;
        }
        gameState.players[socket.id] = {
            id: socket.id,
            name: nickname,
            score: 0
        };
        broadcastState();
    });

    socket.on('start_game', () => {
        if (Object.keys(gameState.players).length === 2) {
            gameState.round = 0;
            gameState.players[Object.keys(gameState.players)[0]].score = 0;
            gameState.players[Object.keys(gameState.players)[1]].score = 0;

            // initialize game session subsets
            gameState.gameQuestions = getRandomSubset(ALL_QUESTIONS, 10);
            gameState.gamePunishments = getRandomSubset(ALL_PUNISHMENTS, 10);

            nextRound();
        }
    });

    socket.on('submit_answer', (text) => {
        if (gameState.status !== 'QUESTION') return;
        gameState.answers[socket.id] = text;

        // If both answered, stop timer and go to voting
        if (Object.keys(gameState.answers).length === 2) {
            clearInterval(gameState.timerInterval);
            evaluateVotingPhase();
        } else {
            broadcastState(); // Show "waiting..."
        }
    });

    socket.on('vote_answer', (isCorrect) => {
        if (gameState.status !== 'VOTING') return;
        gameState.votes[socket.id] = isCorrect;

        if (Object.keys(gameState.votes).length === 2) {
            evaluatePunishmentOrNext();
        }
    });

    socket.on('punishment_done', () => {
        if (gameState.status !== 'PUNISHMENT') return;
        if (!gameState.punishmentDone.includes(socket.id)) {
            gameState.punishmentDone.push(socket.id);
        }

        // Verify if all losers are done
        const allDone = gameState.punishmentLosers.every(id => gameState.punishmentDone.includes(id));
        if (allDone) {
            nextRound();
        }
    });

    socket.on('restart_game', () => {
        gameState.status = 'LOBBY';
        gameState.players = {}; // Or keep players and reset scores? Requirement: "vuelve a la página para ingresar el nickname" -> Reset all.
        gameState.round = 0;
        broadcastState();
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        delete gameState.players[socket.id];
        // If playing, reset or pause? For simplicity, reset to lobby
        if (gameState.status !== 'LOBBY' && gameState.status !== 'RESULTS') {
            gameState.status = 'LOBBY';
            gameState.players = {}; // Force reset
            io.emit('game_reset', 'Player disconnected');
        }
        broadcastState();
    });
});


const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`SERVER RUNNING ON PORT ${PORT}`);
});
