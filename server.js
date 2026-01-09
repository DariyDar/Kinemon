/**
 * Kinemon Games - Online Multiplayer Server with Rooms
 * Manages game rooms, player connections, and collision detection
 */

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Debug logging flag - set DEBUG=true environment variable to enable verbose logs
const DEBUG = process.env.DEBUG === 'true' || false;
const debugLog = (...args) => DEBUG && console.log(...args);

const PORT = process.env.PORT || 8080;

// Game constants
const INVULNERABILITY_DURATION_MS = 5000;  // Ship respawn invulnerability (5 seconds)
const DEFAULT_THRUST_SYSTEM = 'gradient';  // Ship game default (gradient or pump)
const DEFAULT_ENGINE_FORMULA = 'linear';   // Thrust calculation formula (linear, quadratic, exponential)
const RECONNECT_GRACE_PERIOD_MS = 60000;   // 60 seconds to reconnect before player is fully removed

// Create HTTP server to serve static files
const server = http.createServer((req, res) => {
    // Add CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    let filePath = '.' + req.url;
    if (filePath === './') filePath = './index.html';

    const extname = path.extname(filePath);
    const contentType = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css'
    }[extname] || 'text/plain';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404);
            res.end('File not found');
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

// Create WebSocket server with increased buffer limits
const wss = new WebSocket.Server({
    server,
    maxPayload: 100 * 1024 * 1024, // 100MB max message size
    perMessageDeflate: false // Disable compression for better performance with many clients
});

// Game rooms: roomId -> room data
const rooms = new Map();

// Disconnected players: sessionToken -> { roomId, playerId, disconnectTime, playerData }
const disconnectedPlayers = new Map();

// Game constants
const BASE_MOVE_SPEED = 1.8;
const INITIAL_LENGTH = 7;
const DEFAULT_CANVAS = { width: 600, height: 800 };
const BASE_SEGMENT_SIZE = 15;
const BASE_PIZZA_SIZE = 8;  // Reduced from 18 for stardust effect
const BOUNDARY_MARGIN_BOTTOM = 40;

// Pushers constants
const PUSHERS_SQUARE_SIZE = 30;
const PUSHERS_SMILEY_SIZE = 20;
const PUSHERS_SKULL_SIZE = 30;
const PUSHERS_FIELD_SIZE = 800;

// Generate random room ID (word-based with vowel separator)
function generateRoomId() {
    let roomId;
    let attempts = 0;
    const maxAttempts = 100;

    do {
        const prefixes = ['CAT', 'DOG', 'NERD', 'DUMB', 'FISH', 'BIRD', 'FROG', 'BEAR',
                          'WOLF', 'DEER', 'DUCK', 'CRAB', 'SEAL', 'CROW'];
        const vowels = ['A', 'O', 'E', 'U', 'I'];
        const suffixes = ['LAND', 'VILL', 'TOWN', 'ZONE', 'BASE', 'CITY'];

        const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
        const vowel = vowels[Math.floor(Math.random() * vowels.length)];
        const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];

        roomId = prefix + vowel + suffix; // e.g., "CATALAND", "NERDOVILL"
        attempts++;

        if (attempts >= maxAttempts) {
            // Fallback: add random number if too many collisions
            roomId = roomId + Math.floor(Math.random() * 100);
            break;
        }
    } while (rooms.has(roomId));

    return roomId;
}

// Generate secure session token for reconnection
function generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
}

// Clean up expired disconnections (called periodically)
function cleanupExpiredDisconnections() {
    const now = Date.now();
    for (const [token, data] of disconnectedPlayers.entries()) {
        if (now - data.disconnectTime > RECONNECT_GRACE_PERIOD_MS) {
            console.log(`[RECONNECT] Grace period expired for player ${data.playerData.name} (token: ${token.substring(0, 8)}...)`);
            disconnectedPlayers.delete(token);

            // Remove player from room if they still exist
            const room = rooms.get(data.roomId);
            if (room && room.players.has(data.playerId)) {
                room.players.delete(data.playerId);
                console.log(`[RECONNECT] Removed expired player ${data.playerData.name} from room ${data.roomId}`);
                broadcastGameState(room);
            }
        }
    }
}

// Start cleanup interval (runs every 10 seconds)
setInterval(cleanupExpiredDisconnections, 10000);

// Generate random player color (ensures no duplicates in room)
function getRandomColor(room) {
    const colors = ['#4CAF50', '#2196F3', '#FF9800', '#E91E63', '#9C27B0', '#00BCD4', '#FFEB3B', '#795548'];

    // If no room provided, return random color
    if (!room || !room.players) {
        return colors[Math.floor(Math.random() * colors.length)];
    }

    // Get colors already in use
    const usedColors = new Set();
    for (const player of room.players.values()) {
        if (player.color) {
            usedColors.add(player.color);
        }
    }

    // Find available colors
    const availableColors = colors.filter(color => !usedColors.has(color));

    // If all colors are used, start reusing them
    if (availableColors.length === 0) {
        return colors[Math.floor(Math.random() * colors.length)];
    }

    // Return random available color
    return availableColors[Math.floor(Math.random() * availableColors.length)];
}

// Seeded Random Number Generator for Ballz (deterministic block spawning)
function createSeededRNG(seed) {
    let state = seed;
    return function() {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
    };
}

// Create new room
function createRoom(roomId, gameType = 'snake', settings = {}) {
    const room = {
        id: roomId,
        gameType: gameType, // 'pong' or 'snake'
        settings: settings,
        players: new Map(),
        gameLoopInterval: null,
        winner: null,
        gameOver: false
    };

    // Set canvas size based on client viewport dimensions (for Snake) or use default (for Pong)
    if (gameType === 'snake' && settings.canvasWidth && settings.canvasHeight) {
        // Use client-reported dimensions with validation
        const width = Math.max(400, Math.min(2560, settings.canvasWidth));
        const height = Math.max(600, Math.min(3840, settings.canvasHeight));
        room.canvas = { width, height };
        console.log(`Snake canvas: ${width}x${height}`);
    } else {
        room.canvas = { ...DEFAULT_CANVAS };
    }

    // Initialize game-specific state
    if (gameType === 'pong') {
        // Pong: ball and scores
        const baseSpeed = (settings.ballSpeed || 3) * 0.8;
        room.ball = {
            x: room.canvas.width / 2,
            y: room.canvas.height / 2,
            radius: 8,
            speedX: baseSpeed,
            speedY: (settings.ballSpeed || 3) * 0.6,
            baseSpeedX: baseSpeed,  // Store original speed for reset
            maxSpeedX: baseSpeed * 3 // Cap at 3x base speed
        };
        room.paddleSize = (settings.paddleSize || 2) * 50; // 50, 100, 150
        room.winScore = settings.winScore || 11;
        room.speedIncrease = settings.speedIncrease || 2; // 1=5%, 2=15%, 3=30% per hit
        room.gameStarted = false; // Game starts when 2 players join
    } else if (gameType === 'pushers') {
        // Pushers: team-based square pushing game
        room.canvas = { width: PUSHERS_FIELD_SIZE, height: PUSHERS_FIELD_SIZE };
        room.squareSize = PUSHERS_SQUARE_SIZE;
        room.smileySize = PUSHERS_SMILEY_SIZE;
        room.skullSize = PUSHERS_SKULL_SIZE;
        room.winScore = settings.winScore || 15;
        room.nextPlayerId = 0; // For axis assignment

        // Team scores
        room.teamScores = {
            Blue: 0,
            Red: 0,
            Yellow: 0,
            Green: 0,
            White: 0
        };

        // Spawn skulls at corners
        const margin = PUSHERS_SKULL_SIZE / 2;
        room.skulls = [
            { x: margin, y: margin },
            { x: room.canvas.width - margin, y: margin },
            { x: margin, y: room.canvas.height - margin },
            { x: room.canvas.width - margin, y: room.canvas.height - margin }
        ];

        // Spawn first smiley
        room.smiley = spawnSmiley(room);

        // Initialize ghost system
        room.ghosts = [];
        room.smileysCollected = 0;
        room.ghostSize = PUSHERS_SKULL_SIZE; // 30px
    } else if (gameType === 'ship') {
        // Ship: cooperative space game
        // Set canvas size based on client viewport dimensions (like Snake)
        if (settings.canvasWidth && settings.canvasHeight) {
            const width = Math.max(400, Math.min(2560, settings.canvasWidth));
            const height = Math.max(600, Math.min(3840, settings.canvasHeight));
            room.canvas = { width, height };
            console.log(`Ship canvas: ${width}x${height}`);
        }

        // Initialize two ships for team-based gameplay
        room.ships = {
            blue: {
                team: 'blue',
                x: room.canvas.width * 0.25,  // Left-center spawn
                y: room.canvas.height / 2,
                radius: 30,
                vx: 0,
                vy: 0,
                rotation: 0,
                health: 100,
                maxHealth: 100,
                coins: 0,
                lastDamageTime: 0,
                invulnerable: true,
                invulnerableUntil: Date.now() + INVULNERABILITY_DURATION_MS,
                spawnTime: Date.now(),
                alive: true,
                boosters: {  // v3.17: Power-ups
                    extraBullets: 0,
                    laserSight: false,
                    attackShield: { active: false, sizeBonus: 0 },
                    attackEngine: { active: false, level: 0 }
                }
            },
            pink: {
                team: 'pink',
                x: room.canvas.width * 0.75,  // Right-center spawn
                y: room.canvas.height / 2,
                radius: 30,
                vx: 0,
                vy: 0,
                rotation: 0,
                health: 100,
                maxHealth: 100,
                coins: 0,
                lastDamageTime: 0,
                invulnerable: true,
                invulnerableUntil: Date.now() + INVULNERABILITY_DURATION_MS,
                spawnTime: Date.now(),
                alive: true,
                boosters: {  // v3.17: Power-ups
                    extraBullets: 0,
                    laserSight: false,
                    attackShield: { active: false, sizeBonus: 0 },
                    attackEngine: { active: false, level: 0 }
                }
            }
        };

        // Separate systems for each team
        room.teamSystems = {
            blue: {
                engine: { amplitude: 0, energy: 0, hasPlayer: false },
                rudder: { rotation: 0, autoRotateSpeed: 0.5 },
                weapon: { energy: 0, lastWeaponTilt: undefined, isCharging: false, hasPlayer: false },
                weaponDirection: { rotation: 0, autoRotateSpeed: 0.7 },
                shield: { rotation: 0, arcSize: 72, active: false }
            },
            pink: {
                engine: { amplitude: 0, energy: 0, hasPlayer: false },
                rudder: { rotation: 0, autoRotateSpeed: 0.5 },
                weapon: { energy: 0, lastWeaponTilt: undefined, isCharging: false, hasPlayer: false },
                weaponDirection: { rotation: 0, autoRotateSpeed: 0.7 },
                shield: { rotation: 0, arcSize: 72, active: false }
            }
        };

        // Keep old room.systems for backward compatibility (points to blue team)
        room.systems = room.teamSystems.blue;

        room.bullets = [];
        room.asteroids = [];
        room.lastAsteroidSpawn = Date.now();
        room.coins = [];
        room.hearts = [];
        room.loot = [];  // v3.17: Loot drops from asteroids

        // Settings
        room.coinsToWin = settings.coinsToWin || 10;
        room.asteroidFrequency = settings.asteroidFrequency || 'medium';
        room.autopilotEnabled = settings.autopilotEnabled !== undefined ? settings.autopilotEnabled : false; // Default: disabled
        room.coinSpawn = settings.coinSpawn !== undefined ? settings.coinSpawn : true; // Default: enabled

        // Set default thrust system and engine formula (removed from UI in v3.17.3)
        room.thrustSystem = DEFAULT_THRUST_SYSTEM;
        room.engineFormula = DEFAULT_ENGINE_FORMULA;

        // Initialize coins - only if coinSpawn is enabled
        if (room.coinSpawn) {
            room.coins.push(spawnCoin(room));
        }

        room.gameStarted = false; // Ship starts after all players ready (lobby system)
        room.lobbyCountdown = null; // Countdown timer
        room.lobbyCountdownStart = null; // Countdown start time
    } else if (gameType === 'ballz') {
        // Ballz v3.25.0: Single-player physics arcade
        // Adaptive canvas sizing - actual dimensions set client-side
        // All measurements are relative to canvas size

        // Gameplay settings
        room.cols = settings.cols || 7; // Grid columns (7 default)
        room.rows = settings.rows || 14; // Grid rows (14 default)
        room.aspectRatio = settings.aspectRatio || 0.75; // Width/Height = 3:4

        // HP progression
        room.hpIncreaseEveryN = settings.hpIncreaseEveryN || 5; // HP+1 every N turns
        room.maxBlockHP = settings.maxBlockHP || 50;
        room.lowerHPChance = settings.lowerHPChance || 30; // % chance for lower HP

        // Ball physics
        room.ballSpeed = settings.ballSpeed || 3; // 1=slow, 5=fast
        room.ballLaunchDelay = settings.ballLaunchDelay || 100; // ms between balls
        room.bonusBallSpawnRate = settings.bonusBallSpawnRate || 15; // % chance per turn

        // Controls
        room.chargeTime = settings.chargeTime || 2000; // ms to full charge
        room.deadZoneSize = settings.deadZoneSize !== undefined ? settings.deadZoneSize : 0.05; // 5% default

        // NO multiplayer - single player only
        room.maxPlayers = 1;
    } else {
        // Snake: pizzas and calculated settings
        room.moveSpeed = BASE_MOVE_SPEED * ((settings.moveSpeed || 3) / 3); // 3 = fastest
        room.turnSpeedMultiplier = settings.turnSpeed || 2;
        room.controlMapping = settings.controlMapping || 'linear';
        room.sizeMultiplier = settings.snakeSize || 1;
        room.segmentSize = BASE_SEGMENT_SIZE * room.sizeMultiplier;
        room.pizzaSize = BASE_PIZZA_SIZE * room.sizeMultiplier;
        room.growthSpeed = settings.growthSpeed || 1; // Growth multiplier: 1=slow, 2=medium, 4=fast, 8=super fast

        room.pizzas = [];
        const initialCount = room.settings.initialPizzas || 100;
        for (let i = 0; i < initialCount; i++) {
            room.pizzas.push(spawnPizza(room));
        }
    }

    rooms.set(roomId, room);
    console.log(`Room created: ${roomId} (${gameType})`);

    // Start game loop for this room
    room.gameLoopInterval = setInterval(() => gameLoop(roomId), 1000 / 60);

    return room;
}

// ============================================================================
// REPLAY SYSTEM - Helper Functions
// ============================================================================

// Broadcast message to all clients in a room
function broadcastToRoom(roomId, message) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.roomId === roomId) {
            client.send(JSON.stringify(message));
        }
    });
}

// Reset room for replay (same game type)
function resetRoomForReplay(room, preserveRoles = true) {
    // Reset general state
    room.gameOver = false;
    room.winner = null;

    // Reset all player scores
    room.players.forEach(player => {
        player.score = 0;
    });

    // Game-specific reset
    if (room.gameType === 'snake') {
        resetSnakeGame(room);
    } else if (room.gameType === 'pong') {
        resetPongGame(room);
    } else if (room.gameType === 'pushers') {
        resetPushersGame(room);
    } else if (room.gameType === 'ship') {
        resetShipGame(room, preserveRoles);
    }

    console.log(`Room ${room.id} reset for replay (${room.gameType})`);
}

// Reset Snake game state
function resetSnakeGame(room) {
    room.players.forEach(player => {
        player.alive = true;
        player.angle = 0;
        player.targetAngle = 0;
        player.headX = room.canvas.width / 2 + (Math.random() - 0.5) * 200;
        player.headY = room.canvas.height / 2 + (Math.random() - 0.5) * 200;

        // Reset segments to initial length
        player.segments = [];
        for (let i = 0; i < INITIAL_LENGTH; i++) {
            player.segments.push({
                x: player.headX - i * room.segmentSize,
                y: player.headY
            });
        }
    });

    // Respawn pizzas
    room.pizzas = [];
    const initialCount = room.settings.initialPizzas || 100;
    for (let i = 0; i < initialCount; i++) {
        room.pizzas.push(spawnPizza(room));
    }
}

// Reset Pong game state
function resetPongGame(room) {
    // Reset ball
    resetBall(room);
    room.gameStarted = true;

    // Reset paddle positions
    room.players.forEach(player => {
        player.paddleY = room.canvas.height / 2 - room.paddleSize / 2;
    });
}

// Reset Pushers game state
function resetPushersGame(room) {
    // Reset team scores
    room.teamScores = { Blue: 0, Red: 0, Yellow: 0, Green: 0, White: 0 };
    room.smileysCollected = 0;
    room.ghosts = [];

    // Reset square and smiley
    room.square = {
        x: room.canvas.width / 2,
        y: room.canvas.height / 2,
        vx: 0,
        vy: 0
    };
    room.smiley = spawnSmiley(room);

    // Reset player positions
    room.players.forEach(player => {
        const margin = room.squareSize / 2 + 10;
        if (player.axis === 'x') {
            player.x = room.canvas.width / 2;
            player.y = margin + Math.random() * (room.canvas.height - 2 * margin);
        } else {
            player.x = margin + Math.random() * (room.canvas.width - 2 * margin);
            player.y = room.canvas.height / 2;
        }
    });
}

// Reset Ship game state
function resetShipGame(room, preserveRoles) {
    const INVULNERABILITY_DURATION_MS = 3000;

    // Reset ships
    room.ships.blue = {
        team: 'blue',
        x: room.canvas.width * 0.25,
        y: room.canvas.height / 2,
        radius: 30,
        vx: 0, vy: 0, rotation: 0,
        health: 100, maxHealth: 100, coins: 0,
        invulnerable: true,
        invulnerableUntil: Date.now() + INVULNERABILITY_DURATION_MS,
        spawnTime: Date.now(),
        alive: true,
        boosters: { extraBullets: 0, laserSight: false, attackShield: { active: false }, attackEngine: { active: false } }
    };
    room.ships.pink = {
        team: 'pink',
        x: room.canvas.width * 0.75,
        y: room.canvas.height / 2,
        radius: 30,
        vx: 0, vy: 0, rotation: Math.PI,
        health: 100, maxHealth: 100, coins: 0,
        invulnerable: true,
        invulnerableUntil: Date.now() + INVULNERABILITY_DURATION_MS,
        spawnTime: Date.now(),
        alive: true,
        boosters: { extraBullets: 0, laserSight: false, attackShield: { active: false }, attackEngine: { active: false } }
    };

    // Reset team systems
    ['blue', 'pink'].forEach(team => {
        room.teamSystems[team] = {
            engine: { amplitude: 0, energy: 0, hasPlayer: false },
            rudder: { rotation: 0, autoRotateSpeed: 0.5 },
            weapon: { energy: 0, lastWeaponTilt: undefined, isCharging: false, hasPlayer: false },
            weaponDirection: { rotation: 0, autoRotateSpeed: 0.7 },
            shield: { rotation: 0, arcSize: 72, active: false }
        };
    });

    // Clear game objects
    room.bullets = [];
    room.asteroids = [];
    room.hearts = [];
    room.loot = [];
    // Initialize coins only if coinSpawn is enabled
    room.coins = room.coinSpawn ? [spawnCoin(room)] : [];
    room.lastAsteroidSpawn = Date.now();

    // Handle roles/lobby
    if (preserveRoles) {
        // Keep teams and roles, mark all players as ready
        room.players.forEach(player => {
            player.ready = true;
        });
        room.gameStarted = true;
        room.gameState = 'playing';
    } else {
        // Return to lobby - reset roles and ready status, allow new role selection
        room.players.forEach(player => {
            player.ready = false;
            player.systemRole = null;  // Reset role so players can choose again
            // Keep team assignment - players stay on their teams
        });
        room.gameStarted = false;
        room.gameState = 'lobby';
        room.lobbyCountdown = null;
        room.lobbyCountdownStart = null;
    }
}

// Migrate room to new game type
function migrateRoomToNewGame(oldRoom, newGameType, newSettings) {
    const newRoomId = generateRoomId();

    // Save player information
    const playerList = Array.from(oldRoom.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        ws: p.ws,
        color: p.color,
        controlScheme: p.controlScheme || 'arrow_instant' // for Snake
    }));

    // Create new room
    createRoom(newRoomId, newGameType, newSettings);
    const newRoom = rooms.get(newRoomId);

    // Migrate players
    playerList.forEach(info => {
        const player = initializePlayerForGame(newGameType, info, newRoom);

        // Update WebSocket associations
        info.ws.roomId = newRoomId;
        info.ws.playerId = player.id;

        newRoom.players.set(player.id, player);
    });

    // Set gameStarted based on game type
    if (newGameType === 'pong' && newRoom.players.size === 2) {
        newRoom.gameStarted = true;
    } else if (newGameType === 'ship') {
        newRoom.gameStarted = false; // Requires lobby
        newRoom.gameState = 'lobby';
    } else {
        newRoom.gameStarted = true;
    }

    // Migrate Display WebSocket if present
    if (oldRoom.displayWs) {
        oldRoom.displayWs.roomId = newRoomId;
        oldRoom.displayWs.isDisplay = true;
        newRoom.displayWs = oldRoom.displayWs;
    }

    // Destroy old room
    clearInterval(oldRoom.gameLoopInterval);
    rooms.delete(oldRoom.id);

    console.log(`Migrated from ${oldRoom.id} (${oldRoom.gameType}) to ${newRoomId} (${newGameType})`);

    return { newRoomId, newRoom };
}

// Initialize player for specific game type
function initializePlayerForGame(gameType, playerInfo, room) {
    const player = {
        id: playerInfo.id,
        name: playerInfo.name,
        color: playerInfo.color,
        score: 0,
        tilt: 0.5,
        ws: playerInfo.ws
    };

    // Game-specific initialization
    if (gameType === 'snake') {
        player.alive = true;
        player.controlScheme = playerInfo.controlScheme || 'arrow_instant';
        player.angle = 0;
        player.targetAngle = 0;
        player.headX = room.canvas.width / 2 + (Math.random() - 0.5) * 200;
        player.headY = room.canvas.height / 2 + (Math.random() - 0.5) * 200;

        player.segments = [];
        for (let i = 0; i < INITIAL_LENGTH; i++) {
            player.segments.push({
                x: player.headX - i * room.segmentSize,
                y: player.headY
            });
        }
    } else if (gameType === 'pong') {
        player.paddleY = room.canvas.height / 2 - room.paddleSize / 2;
    } else if (gameType === 'pushers') {
        player.team = playerInfo.color;
        const margin = room.squareSize / 2 + 10;

        // Alternate between x and y axis
        const existingPlayers = Array.from(room.players.values());
        const xAxisCount = existingPlayers.filter(p => p.axis === 'x').length;
        const yAxisCount = existingPlayers.filter(p => p.axis === 'y').length;

        if (xAxisCount <= yAxisCount) {
            player.axis = 'x';
            player.x = room.canvas.width / 2;
            player.y = margin + Math.random() * (room.canvas.height - 2 * margin);
        } else {
            player.axis = 'y';
            player.x = margin + Math.random() * (room.canvas.width - 2 * margin);
            player.y = room.canvas.height / 2;
        }
    } else if (gameType === 'ship') {
        // Ship requires lobby - assign default team but no role yet
        player.team = room.players.size % 2 === 0 ? 'blue' : 'pink';
        player.systemRole = null;
        player.ready = false;
    }

    return player;
}

// Spawn pizza
function spawnPizza(room) {
    const pizzaSize = room ? room.pizzaSize : BASE_PIZZA_SIZE;
    const margin = pizzaSize;
    const minX = margin;
    const maxX = room.canvas.width - margin;
    const minY = margin;
    const maxY = room.canvas.height - BOUNDARY_MARGIN_BOTTOM - margin;

    return {
        x: minX + Math.random() * (maxX - minX),
        y: minY + Math.random() * (maxY - minY),
        id: Date.now() + Math.random()
    };
}

// Pushers helper functions
function spawnSmiley(room) {
    const margin = room.smileySize;
    const minX = margin + 50;
    const maxX = room.canvas.width - margin - 50;
    const minY = margin + 50;
    const maxY = room.canvas.height - margin - 50;

    return {
        x: minX + Math.random() * (maxX - minX),
        y: minY + Math.random() * (maxY - minY)
    };
}

function getTeamColor(team) {
    const colors = {
        Blue: '#2196F3',
        Red: '#F44336',
        Yellow: '#FFEB3B',
        Green: '#4CAF50',
        White: '#FFFFFF'
    };
    return colors[team] || '#FFFFFF';
}

function spawnPlayerSquare(room, axis) {
    const margin = room.squareSize / 2 + 10;
    let x, y;

    if (axis === 'X') {
        // Spawn on left or right edge
        x = Math.random() > 0.5 ? margin : room.canvas.width - margin;
        y = margin + Math.random() * (room.canvas.height - 2 * margin);
    } else { // Y axis
        // Spawn on top or bottom edge
        x = margin + Math.random() * (room.canvas.width - 2 * margin);
        y = Math.random() > 0.5 ? margin : room.canvas.height - margin;
    }

    return { x, y };
}

// Spawn ghost enemy for Pushers
function spawnGhost(room) {
    const margin = room.ghostSize / 2 + 50;
    const x = margin + Math.random() * (room.canvas.width - 2 * margin);
    const y = margin + Math.random() * (room.canvas.height - 2 * margin);

    const angle = Math.random() * Math.PI * 2;
    const speed = 2.5;

    return {
        x: x,
        y: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: room.ghostSize,
        id: Date.now() + Math.random()
    };
}

// ===== Ship helper functions =====

// Spawn coin for Ship game
function spawnCoin(room) {
    const margin = 50;
    return {
        x: margin + Math.random() * (room.canvas.width - 2 * margin),
        y: margin + Math.random() * (room.canvas.height - 2 * margin),
        id: Date.now() + Math.random()
    };
}

// Get position on ship hull for a system at given rotation
function getSystemPosition(ship, rotation) {
    const angle = rotation * Math.PI / 180;
    return {
        x: ship.x + Math.cos(angle) * ship.radius,
        y: ship.y + Math.sin(angle) * ship.radius,
        angle: angle
    };
}

// Detect pump motion (upward movement from below 0.5 to above 0.5)
// Returns energy added from the pump
function detectPump(player, currentTilt, room) {
    // Initialize lastTilt if not set
    if (player.lastTilt === undefined) {
        player.lastTilt = currentTilt;
        return 0;
    }

    const lastTilt = player.lastTilt;
    const delta = currentTilt - lastTilt;
    player.lastTilt = currentTilt;

    // Detect ANY significant upward movement (delta > threshold)
    const pumpThreshold = (room.physics && room.physics.pumpMinDelta) || 0.15;

    if (delta > pumpThreshold) {
        // Pump detected! Energy based on movement magnitude
        const pumpStrength = Math.min(delta, 0.5) * 2; // 0-1 (normalized)
        const pumpEnergyMult = (room.physics && room.physics.pumpEnergy) || 16;
        const energyBoost = pumpStrength * pumpEnergyMult;
        debugLog(`🚀 Pump! Tilt: ${lastTilt.toFixed(2)} -> ${currentTilt.toFixed(2)} (Δ${delta.toFixed(3)}), Energy: +${energyBoost.toFixed(2)}`);
        return energyBoost;
    }

    return 0; // No pump
}

// Weapon charging based on tilt position (not pump speed)
// Energy = distance traveled upward from lowest point
// Returns { newEnergy, shouldFire, bulletCount }
function updateWeaponCharge(player, currentTilt, room) {
    const weapon = room.systems.weapon;

    // Initialize on first call
    if (weapon.lastWeaponTilt === undefined) {
        weapon.lastWeaponTilt = currentTilt;
        weapon.baseTilt = currentTilt;  // Lowest point for energy calculation
        weapon.movingUp = false;
        weapon.justFired = false;
        return { newEnergy: 0, shouldFire: false, bulletCount: 0 };
    }

    const lastTilt = weapon.lastWeaponTilt;
    const delta = currentTilt - lastTilt;
    weapon.lastWeaponTilt = currentTilt;

    // Track direction of movement
    const currentlyMovingUp = delta > 0.01;
    const currentlyMovingDown = delta < -0.01;

    // Update base to track the lowest point during movement
    if (!weapon.movingUp && currentlyMovingUp) {
        // Starting to move up - set base to current position (lowest point)
        weapon.baseTilt = currentTilt;
        weapon.movingUp = true;
        weapon.justFired = false; // Clear fired flag on new upward movement
        console.log(`⬆️ Started moving up from base: ${currentTilt.toFixed(3)}`);
    } else if (weapon.movingUp && currentlyMovingDown) {
        // Starting to move down - FIRE!
        const shouldFire = true;
        const bulletCount = Math.max(1, Math.ceil(weapon.energy));
        console.log(`💥 Weapon Fire! Energy: ${weapon.energy.toFixed(2)}, Bullets: ${bulletCount}`);

        weapon.movingUp = false;
        weapon.justFired = true; // Mark as just fired
        weapon.baseTilt = 999; // Set base impossibly high so energy stays 0
        return { newEnergy: 0, shouldFire, bulletCount }; // Energy immediately 0 after fire
    } else if (currentlyMovingUp) {
        weapon.movingUp = true;
    } else if (currentlyMovingDown) {
        weapon.movingUp = false;
        // Continue tracking downward - update base to lowest point (only if not just fired)
        if (!weapon.justFired) {
            weapon.baseTilt = Math.min(weapon.baseTilt, currentTilt);
        }
    }

    // Energy = relative distance from base position (0-1 → 0-10)
    // If just fired, keep energy at 0 until new upward movement starts
    const relativeTilt = weapon.justFired ? 0 : Math.max(0, currentTilt - weapon.baseTilt);
    const newEnergy = relativeTilt * 10;

    // Charging when relative energy > 0
    weapon.isCharging = relativeTilt > 0.05;

    return { newEnergy, shouldFire: false, bulletCount: 0 };
}

/**
 * Gradient Energy System - Calculates energy from phone tilt angle
 *
 * Players hold their phone and tilt it upward to charge energy.
 * Energy gain increases exponentially with tilt angle:
 *
 * - 0-70°:  1.0 energy/degree  (easy, rapid charging)
 * - 70-85°: 1.5 energy/degree  (moderate difficulty)
 * - 85-89°: 5.0 energy/degree  (high precision required)
 * - 89-90°: 10.0 energy/degree (extreme difficulty, vertical hold)
 *
 * This creates engaging risk/reward gameplay - steep tilts yield more energy
 * but are harder to maintain. Energy decays over time, so players must
 * continuously pump to maintain thrust.
 *
 * @param {number} currentTilt - Current phone angle (0=horizontal, 1=vertical)
 * @param {number} lastTilt - Previous phone angle (undefined on first call)
 * @returns {number} Energy gained this frame (0 if tilting down or first call)
 */
function calculateGradientEnergy(currentTilt, lastTilt) {
    // Initialize on first call - no energy on first frame
    if (lastTilt === undefined) return 0;

    // tilt range: 0 (horizontal) to 1 (vertical)
    // Convert to degrees: 0-90
    const currentDegrees = currentTilt * 90;
    const lastDegrees = lastTilt * 90;

    // Only count upward movement
    if (currentDegrees <= lastDegrees) return 0;

    let energy = 0;

    // Progressive energy calculation - iterate through degree ranges
    for (let deg = Math.floor(lastDegrees); deg < Math.floor(currentDegrees); deg++) {
        if (deg < 70) {
            energy += 1.0;  // First 70 degrees: 1 point/degree
        } else if (deg < 85) {
            energy += 1.5;  // Next 15 degrees: 1.5 points/degree
        } else if (deg < 89) {
            energy += 5.0;  // Next 4 degrees: 5 points/degree
        } else {
            energy += 10.0; // Last degree: 10 points
        }
    }

    return energy;
}

// Get current energy level (1-5) for gradient system
// Used for visual feedback and decay rate calculation
function getEnergyLevel(energy) {
    if (energy >= 600) return 5; // Red (600-750)
    if (energy >= 450) return 4; // Orange (450-600)
    if (energy >= 300) return 3; // Yellow (300-450)
    if (energy >= 150) return 2; // Green (150-300)
    if (energy > 0) return 1;    // Blue (0-150)
    return 0;
}

// Calculate engine thrust from accumulated energy
function calculateEngineThrust(energy, formula, room) {
    if (energy <= 0) return 0;

    // Base multiplier (zone 1: 0-150)
    const baseMult = (room.physics && room.physics.thrustMult) || 0.5;

    // Determine zone and calculate compound multiplier (+20% per zone)
    let zoneMultiplier = 1.0;

    if (energy >= 600) {
        // Zone 5 (600-750): 4 compounded 20% increases
        zoneMultiplier = 1.2 * 1.2 * 1.2 * 1.2; // = 2.0736
    } else if (energy >= 450) {
        // Zone 4 (450-600): 3 compounded 20% increases
        zoneMultiplier = 1.2 * 1.2 * 1.2; // = 1.728
    } else if (energy >= 300) {
        // Zone 3 (300-450): 2 compounded 20% increases
        zoneMultiplier = 1.2 * 1.2; // = 1.44
    } else if (energy >= 150) {
        // Zone 2 (150-300): 1 compounded 20% increase
        zoneMultiplier = 1.2;
    }
    // Zone 1 (0-150): multiplier = 1.0 (base)

    const finalMult = baseMult * zoneMultiplier;

    // Normalize energy for gradient system (0-750 range)
    const normalizedEnergy = Math.min(energy / 750, 1);

    // Apply formula modifiers
    switch (formula) {
        case 'balanced':
            return finalMult * normalizedEnergy;
        case 'speed':
            return (finalMult * 1.25) * normalizedEnergy;
        case 'combo':
            return (finalMult * 0.75) * normalizedEnergy;
        default:
            return finalMult * normalizedEnergy;
    }
}

// Apply engine thrust to ship
function applyEngineThrust(room) {
    const thrust = calculateEngineThrust(room.systems.engine.energy, room.engineFormula, room);

    if (thrust > 0) {
        const angle = room.systems.rudder.rotation * Math.PI / 180;

        // Reactive thrust - ship moves OPPOSITE to engine direction
        room.ship.vx += -Math.cos(angle) * thrust;
        room.ship.vy += -Math.sin(angle) * thrust;

        debugLog(`Thrust applied: ${thrust.toFixed(3)}, Energy: ${room.systems.engine.energy.toFixed(2)}, Speed: ${Math.hypot(room.ship.vx, room.ship.vy).toFixed(2)}`);

        // Speed boost for gradient system (+10% per energy level)
        let speedMultiplier = 1.0;
        if (room.thrustSystem === 'gradient') {
            const level = getEnergyLevel(room.systems.engine.energy);
            speedMultiplier = 1.0 + (level * 0.10); // +10% per level (max +50% at level 5)
        }

        // Clamp velocity with speed multiplier (use physics settings)
        const baseMaxSpeed = (room.physics && room.physics.maxSpeed) || 3.0;
        const MAX_SPEED = baseMaxSpeed * speedMultiplier;
        const speed = Math.hypot(room.ship.vx, room.ship.vy);
        if (speed > MAX_SPEED) {
            room.ship.vx = (room.ship.vx / speed) * MAX_SPEED;
            room.ship.vy = (room.ship.vy / speed) * MAX_SPEED;
        }
    }

    // Energy decay (depends on thrust system)
    if (room.thrustSystem === 'gradient') {
        // Progressive decay based on energy level
        const level = getEnergyLevel(room.systems.engine.energy);
        const baseDecay = (room.physics && room.physics.gradientBaseDecay) || 50;
        const decayMultiplier = 1.0 + (level - 1) * 0.5; // +50% per level above 1
        const decayRate = baseDecay * decayMultiplier; // units/second
        const decayPerFrame = decayRate / 60; // Convert to per-frame (60 FPS)
        room.systems.engine.energy = Math.max(0, room.systems.engine.energy - decayPerFrame);
    } else {
        // Pump system - constant decay
        const energyDecay = (room.physics && room.physics.energyDecay) || 50;
        room.systems.engine.energy = Math.max(0, room.systems.engine.energy - energyDecay);
    }
}

// Update ship position with physics
function updateShipPosition(room) {
    room.ship.x += room.ship.vx;
    room.ship.y += room.ship.vy;

    // Inertia controls how quickly ship slows down (0=instant stop, 100=no friction)
    // Convert inertia (0-100) to friction multiplier (0.90-0.995)
    const inertia = (room.physics && room.physics.inertia !== undefined) ? room.physics.inertia : 50;
    const FRICTION = 0.90 + (inertia / 100) * 0.095; // Maps 0→0.90, 50→0.9475, 100→0.995
    room.ship.vx *= FRICTION;
    room.ship.vy *= FRICTION;

    // Full stop at very low speeds to prevent infinite drift (use physics settings)
    const stopThreshold = (room.physics && room.physics.stopThreshold) || 0.05;
    if (Math.abs(room.ship.vx) < stopThreshold) room.ship.vx = 0;
    if (Math.abs(room.ship.vy) < stopThreshold) room.ship.vy = 0;

    // Wrap around edges
    if (room.ship.x < 0) room.ship.x = room.canvas.width;
    if (room.ship.x > room.canvas.width) room.ship.x = 0;
    if (room.ship.y < 0) room.ship.y = room.canvas.height;
    if (room.ship.y > room.canvas.height) room.ship.y = 0;

    // Aesthetic rotation toward velocity direction
    if (Math.hypot(room.ship.vx, room.ship.vy) > 0.5) {
        room.ship.rotation = Math.atan2(room.ship.vy, room.ship.vx);
    }
}

// Calculate bullet parameters from weapon energy (0-10)
// Returns { powerLevel, size, speed, distance, damage, bulletCount }
function calculateBulletParams(energy) {
    // Energy 0-10 → power levels 1-10
    const powerLevel = Math.max(1, Math.min(10, Math.ceil(energy)));

    // Custom balance table for each level
    const balanceTable = {
        1:  { size: 1,  speed: 5,  distance: 100, bulletCount: 1, damage: 0.5 },
        2:  { size: 2,  speed: 6,  distance: 150, bulletCount: 1, damage: 0.6 },
        3:  { size: 3,  speed: 8,  distance: 200, bulletCount: 1, damage: 0.8 },
        4:  { size: 4,  speed: 10, distance: 300, bulletCount: 2, damage: 1.0 },
        5:  { size: 5,  speed: 10, distance: 400, bulletCount: 2, damage: 1.0 },
        6:  { size: 6,  speed: 12, distance: 500, bulletCount: 2, damage: 1.0 },
        7:  { size: 7,  speed: 12, distance: 600, bulletCount: 3, damage: 1.1 },
        8:  { size: 10, speed: 12, distance: 700, bulletCount: 3, damage: 1.2 },
        9:  { size: 12, speed: 14, distance: 800, bulletCount: 3, damage: 1.3 },
        10: { size: 14, speed: 17, distance: 900, bulletCount: 5, damage: 1.5 }
    };

    const stats = balanceTable[powerLevel];
    const size = stats.size;
    const speed = stats.speed;
    const distance = stats.distance;
    const bulletCount = stats.bulletCount;
    const damage = stats.damage;

    console.log(`🎯 Bullet: Lv${powerLevel}, Count:${bulletCount}, Size:${size}px, Speed:${speed}, Dist:${distance}, Dmg:${damage}x`);

    return { powerLevel, size, speed, distance, damage, bulletCount };
}

// Fire bullets from weapon using accumulated energy
// Fire bullet for specific team
function fireBulletForTeam(room, teamColor) {
    const systems = room.teamSystems[teamColor];
    const ship = room.ships[teamColor];
    const weapon = systems.weapon;

    if (weapon.energy < 0.1) return;

    const params = calculateBulletParams(weapon.energy);
    // v3.17: Add extra bullets from booster
    const totalBulletCount = params.bulletCount + (ship.boosters.extraBullets || 0);
    const angle = systems.weaponDirection.rotation * Math.PI / 180;
    const weaponPos = getSystemPosition(ship, systems.weaponDirection.rotation);

    for (let i = 0; i < totalBulletCount; i++) {
        const spread = totalBulletCount > 1 ? (Math.random() - 0.5) * 0.2 : 0;
        const bulletAngle = angle + spread;

        room.bullets.push({
            x: weaponPos.x,
            y: weaponPos.y,
            vx: Math.cos(bulletAngle) * params.speed,
            vy: Math.sin(bulletAngle) * params.speed,
            damage: params.damage,
            size: params.size,
            powerLevel: params.powerLevel,
            distanceTraveled: 0,
            maxDistance: params.distance,
            team: teamColor,  // NEW: bullets have team identity
            id: Date.now() + Math.random() + i
        });
    }

    const effectColor = (params.powerLevel === 10) ? '#FF0000' : (teamColor === 'blue' ? '#2196F3' : '#E91E63');
    broadcastEffect(room.id, 'particle', {
        x: weaponPos.x,
        y: weaponPos.y,
        color: effectColor,
        count: Math.ceil(totalBulletCount / 2)
    });
    broadcastEffect(room.id, 'shake', { intensity: params.powerLevel / 5 });

    weapon.energy = 0;
    weapon.isCharging = false;
}

// Apply engine thrust for specific team
function applyEngineThrustForTeam(room, teamColor) {
    const systems = room.teamSystems[teamColor];
    const ship = room.ships[teamColor];

    const thrust = calculateEngineThrust(systems.engine.energy, room.engineFormula, room);

    if (thrust > 0) {
        const angle = systems.rudder.rotation * Math.PI / 180;

        // Reactive thrust - ship moves OPPOSITE to engine direction
        ship.vx += -Math.cos(angle) * thrust;
        ship.vy += -Math.sin(angle) * thrust;

        debugLog(`[${teamColor}] Thrust applied: ${thrust.toFixed(3)}, Energy: ${systems.engine.energy.toFixed(2)}, Speed: ${Math.hypot(ship.vx, ship.vy).toFixed(2)}`);

        // Speed boost for gradient system (+10% per energy level)
        let speedMultiplier = 1.0;
        if (room.thrustSystem === 'gradient') {
            const level = getEnergyLevel(systems.engine.energy);
            speedMultiplier = 1.0 + (level * 0.10); // +10% per level (max +50% at level 5)
        }

        // Clamp velocity with speed multiplier (use physics settings)
        const baseMaxSpeed = (room.physics && room.physics.maxSpeed) || 3.0;
        const MAX_SPEED = baseMaxSpeed * speedMultiplier;
        const speed = Math.hypot(ship.vx, ship.vy);
        if (speed > MAX_SPEED) {
            ship.vx = (ship.vx / speed) * MAX_SPEED;
            ship.vy = (ship.vy / speed) * MAX_SPEED;
        }
    }

    // Energy decay (depends on thrust system)
    if (room.thrustSystem === 'gradient') {
        // Progressive decay based on energy level
        const level = getEnergyLevel(systems.engine.energy);
        const baseDecay = (room.physics && room.physics.gradientBaseDecay) || 50;
        const decayMultiplier = 1.0 + (level - 1) * 0.5; // +50% per level above 1
        const decayRate = baseDecay * decayMultiplier; // units/second
        const decayPerFrame = decayRate / 60; // Convert to per-frame (60 FPS)
        systems.engine.energy = Math.max(0, systems.engine.energy - decayPerFrame);
    } else {
        // Pump system - constant decay
        const energyDecay = (room.physics && room.physics.energyDecay) || 50;
        systems.engine.energy = Math.max(0, systems.engine.energy - energyDecay);
    }
}

// Update ship position with physics for specific team
function updateShipPositionForTeam(room, teamColor) {
    const ship = room.ships[teamColor];

    ship.x += ship.vx;
    ship.y += ship.vy;

    // Inertia controls how quickly ship slows down (0=instant stop, 100=no friction)
    // Convert inertia (0-100) to friction multiplier (0.90-0.995)
    const inertia = (room.physics && room.physics.inertia !== undefined) ? room.physics.inertia : 50;
    const FRICTION = 0.90 + (inertia / 100) * 0.095; // Maps 0→0.90, 50→0.9475, 100→0.995
    ship.vx *= FRICTION;
    ship.vy *= FRICTION;

    // Full stop at very low speeds to prevent infinite drift (use physics settings)
    const stopThreshold = (room.physics && room.physics.stopThreshold) || 0.05;
    if (Math.abs(ship.vx) < stopThreshold) ship.vx = 0;
    if (Math.abs(ship.vy) < stopThreshold) ship.vy = 0;

    // Wrap around edges
    if (ship.x < 0) ship.x = room.canvas.width;
    if (ship.x > room.canvas.width) ship.x = 0;
    if (ship.y < 0) ship.y = room.canvas.height;
    if (ship.y > room.canvas.height) ship.y = 0;

    // Aesthetic rotation toward velocity direction
    if (Math.hypot(ship.vx, ship.vy) > 0.5) {
        ship.rotation = Math.atan2(ship.vy, ship.vx);
    }
}

// Create asteroid
function createAsteroid(room, size) {
    // Spawn OUTSIDE field boundaries
    const margin = 100;
    const side = Math.floor(Math.random() * 4); // 0=top, 1=right, 2=bottom, 3=left

    let x, y;
    switch(side) {
        case 0: x = Math.random() * room.canvas.width; y = -margin; break;
        case 1: x = room.canvas.width + margin; y = Math.random() * room.canvas.height; break;
        case 2: x = Math.random() * room.canvas.width; y = room.canvas.height + margin; break;
        case 3: x = -margin; y = Math.random() * room.canvas.height; break;
    }

    // Vector toward center with random offset
    const centerX = room.canvas.width / 2;
    const centerY = room.canvas.height / 2;
    const angle = Math.atan2(centerY - y, centerX - x) + (Math.random() - 0.5) * 0.4;

    let speed, health, maxHealth, damage, splits;
    switch(size) {
        case 'large':
            speed = 0.75; health = 10; maxHealth = 10; damage = 3; splits = 2; // Reduced 2x: was 1.5
            break;
        case 'medium':
            speed = 1.0; health = 5; maxHealth = 5; damage = 2; splits = 3; // Reduced 2x: was 2.0
            break;
        case 'small':
            speed = 1.25; health = 2; maxHealth = 2; damage = 1; splits = 0; // Reduced 2x: was 2.5
            break;
    }

    return {
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size,
        radius: size === 'large' ? 20 : (size === 'medium' ? 12 : 8), // Increased 2x: was 10/6/4
        health, maxHealth,
        baseDamage: damage,
        splits,
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * 0.05,
        flashUntil: 0,
        id: Date.now() + Math.random()
    };
}

// Spawn asteroids based on frequency
function spawnAsteroidIfNeeded(room) {
    // Skip spawning if frequency is 'none' (training mode)
    if (room.asteroidFrequency === 'none') return;

    const now = Date.now();
    const intervals = { low: 3000, medium: 2000, high: 1200 };
    const interval = intervals[room.asteroidFrequency] || 2000;

    if (now - room.lastAsteroidSpawn > interval) {
        const rand = Math.random();
        const size = rand < 0.5 ? 'small' : (rand < 0.8 ? 'medium' : 'large');

        room.asteroids.push(createAsteroid(room, size));
        room.lastAsteroidSpawn = now;
    }
}

// Handle asteroid destruction and splitting
function handleAsteroidDestruction(room, asteroid, index) {
    // v3.17: 70% loot drop system for small asteroids
    if (asteroid.size === 'small' && Math.random() < 0.70) {
        const lootTypes = [
            { type: 'coin', weight: 15 },
            { type: 'heart', weight: 15 },
            { type: 'bullet', weight: 15 },
            { type: 'laser', weight: 5 },
            { type: 'attackShield', weight: 10 },
            { type: 'attackEngine', weight: 10 }
        ];

        // Weighted random selection
        const totalWeight = lootTypes.reduce((sum, item) => sum + item.weight, 0);
        let random = Math.random() * totalWeight;
        let selectedType = 'coin';

        for (const loot of lootTypes) {
            random -= loot.weight;
            if (random <= 0) {
                selectedType = loot.type;
                break;
            }
        }

        // Spawn loot with scatter velocity (like coins)
        const angle = Math.random() * Math.PI * 2;
        const speed = 1 + Math.random() * 2;

        room.loot.push({
            x: asteroid.x,
            y: asteroid.y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            type: selectedType,
            id: Date.now() + Math.random(),
            radius: 12
        });
    }

    // Split into smaller asteroids
    if (asteroid.splits > 0) {
        const newSize = asteroid.size === 'large' ? 'medium' : 'small';
        const spreadAngle = Math.PI * 2 / asteroid.splits;

        for (let i = 0; i < asteroid.splits; i++) {
            const angle = spreadAngle * i;
            const speed = asteroid.size === 'large' ? 2.0 : 2.5;

            room.asteroids.push({
                ...createAsteroid(room, newSize),
                x: asteroid.x,
                y: asteroid.y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed
            });
        }
    }

    room.asteroids.splice(index, 1);

    broadcastEffect(room.id, 'particle', { x: asteroid.x, y: asteroid.y, color: '#888888', count: 25 });
    broadcastEffect(room.id, 'shake', { intensity: 3 });
}

// v3.17: Apply loot effect when ship collects loot
function applyLootEffect(room, ship, loot, teamColor) {
    const teamColorHex = teamColor === 'blue' ? '#2196F3' : '#E91E63';

    switch (loot.type) {
        case 'coin':
            ship.coins = (ship.coins || 0) + 1;
            const coinsRemaining = (room.coinsToWin || 10) - ship.coins;
            broadcastEffect(room.id, 'particle', { x: loot.x, y: loot.y, color: '#FFD700', count: 10 });
            broadcastEffect(room.id, 'scoreAnim', {
                x: ship.x,
                y: ship.y - ship.radius - 20,
                text: `ещё ${coinsRemaining} до победы!`,
                color: teamColorHex
            });
            // Spawn new coin only if coinSpawn is enabled
            if (room.coinSpawn) {
                room.coins.push(spawnCoin(room));
            }
            break;

        case 'heart':
            if (ship.health < ship.maxHealth) {
                const actualHealing = Math.min(50, ship.maxHealth - ship.health);
                ship.health = Math.min(ship.maxHealth, ship.health + 50);
                broadcastEffect(room.id, 'particle', { x: loot.x, y: loot.y, color: '#FF1744', count: 15 });
                broadcastEffect(room.id, 'scoreAnim', {
                    x: ship.x,
                    y: ship.y - ship.radius - 20,
                    text: `${actualHealing}HP восстановлено!`,
                    color: '#FF1744'
                });
            }
            break;

        case 'bullet':
            ship.boosters.extraBullets = (ship.boosters.extraBullets || 0) + 1;
            broadcastEffect(room.id, 'particle', { x: loot.x, y: loot.y, color: '#00FFFF', count: 15 });
            broadcastEffect(room.id, 'scoreAnim', {
                x: ship.x,
                y: ship.y - ship.radius - 20,
                text: 'Дополнительный снаряд!',
                color: '#00FFFF'
            });
            break;

        case 'laser':
            ship.boosters.laserSight = true;
            broadcastEffect(room.id, 'particle', { x: loot.x, y: loot.y, color: '#FF0000', count: 15 });
            broadcastEffect(room.id, 'scoreAnim', {
                x: ship.x,
                y: ship.y - ship.radius - 20,
                text: 'Лазерный прицел!',
                color: '#FF0000'
            });
            break;

        case 'attackShield':
            const wasActive = ship.boosters.attackShield.active;
            ship.boosters.attackShield.active = true;
            if (!wasActive) {
                ship.boosters.attackShield.sizeBonus = Math.min(50, (ship.boosters.attackShield.sizeBonus || 0) + 5);
            } else {
                ship.boosters.attackShield.sizeBonus = Math.min(50, ship.boosters.attackShield.sizeBonus + 5);
            }
            broadcastEffect(room.id, 'particle', { x: loot.x, y: loot.y, color: '#FF00FF', count: 15 });
            broadcastEffect(room.id, 'scoreAnim', {
                x: ship.x,
                y: ship.y - ship.radius - 20,
                text: wasActive ? 'Атакующий щит УСИЛЕН!' : 'Атакующий щит!',
                color: '#FF00FF'
            });
            break;

        case 'attackEngine':
            const wasEngineActive = ship.boosters.attackEngine.active;
            ship.boosters.attackEngine.active = true;
            ship.boosters.attackEngine.level = Math.min(10, (ship.boosters.attackEngine.level || 0) + 1);
            broadcastEffect(room.id, 'particle', { x: loot.x, y: loot.y, color: '#FFA500', count: 15 });
            broadcastEffect(room.id, 'scoreAnim', {
                x: ship.x,
                y: ship.y - ship.radius - 20,
                text: wasEngineActive ? 'Атакующий двигатель УСИЛЕН!' : 'Атакующий двигатель!',
                color: '#FFA500'
            });
            break;
    }
}

// Check if angle is within shield arc
function isAngleInShieldArc(angle, shieldRotation, arcSize) {
    const normalizeAngle = (a) => ((a % 360) + 360) % 360;

    const normAngle = normalizeAngle(angle);
    const shieldStart = normalizeAngle(shieldRotation - arcSize / 2);
    const shieldEnd = normalizeAngle(shieldRotation + arcSize / 2);

    if (shieldStart < shieldEnd) {
        return normAngle >= shieldStart && normAngle <= shieldEnd;
    } else {
        return normAngle >= shieldStart || normAngle <= shieldEnd;
    }
}

// Deflect asteroid elastically
function deflectAsteroid(asteroid, ship, shieldRotation, room) {
    const dx = asteroid.x - ship.x;
    const dy = asteroid.y - ship.y;
    const angle = Math.atan2(dy, dx);

    const normalX = Math.cos(angle);
    const normalY = Math.sin(angle);
    const dotProduct = asteroid.vx * normalX + asteroid.vy * normalY;

    // Elastic reflection
    asteroid.vx = asteroid.vx - 2 * dotProduct * normalX;
    asteroid.vy = asteroid.vy - 2 * dotProduct * normalY;

    // Increase speed (shield "repels")
    asteroid.vx *= 1.2;
    asteroid.vy *= 1.2;

    // Push away from ship
    const pushDistance = ship.radius + asteroid.radius + 5;
    asteroid.x = ship.x + Math.cos(angle) * pushDistance;
    asteroid.y = ship.y + Math.sin(angle) * pushDistance;

    broadcastEffect(room.id, 'particle', { x: asteroid.x, y: asteroid.y, color: '#00FFFF', count: 12 });
    broadcastEffect(room.id, 'shake', { intensity: 2 });
}

// Check all Ship collisions
function checkShipCollisions(room) {
    // Support both legacy single ship and new dual ship modes
    const ships = room.ships || { legacy: room.ship };
    const teamColors = room.ships ? ['blue', 'pink'] : ['legacy'];

    // 1. Bullet-Ship collisions (TEAM-AWARE)
    for (let i = room.bullets.length - 1; i >= 0; i--) {
        const bullet = room.bullets[i];
        let bulletHit = false;

        for (const teamColor of teamColors) {
            const ship = ships[teamColor];
            if (!ship || !ship.alive) continue;

            // Friendly fire prevention: bullets skip own team ship
            if (bullet.team && bullet.team === teamColor) continue;

            const dist = Math.hypot(bullet.x - ship.x, bullet.y - ship.y);
            if (dist < (ship.radius || 20) + 5) {
                const systems = room.teamSystems ? room.teamSystems[teamColor] : room.systems;
                const angleToShip = Math.atan2(ship.y - bullet.y, ship.x - bullet.x) * 180 / Math.PI;

                // Check if shield blocks
                if (systems.shield.active && isAngleInShieldArc(angleToShip, systems.shield.rotation, systems.shield.arcSize || 72)) {
                    // Shield deflects and destroys bullet
                    const deflectColor = teamColor === 'pink' ? '#E91E63' : '#2196F3';
                    broadcastEffect(room.id, 'particle', { x: bullet.x, y: bullet.y, color: deflectColor, count: 12 });
                    room.bullets.splice(i, 1);
                    bulletHit = true;
                    break;
                } else {
                    // Bullet hits ship
                    if (!ship.invulnerable) {
                        ship.health = Math.max(0, ship.health - 10); // 10 damage per bullet
                        ship.lastDamageTime = Date.now();

                        const teamColor = bullet.team === 'blue' ? '#2196F3' : (bullet.team === 'pink' ? '#E91E63' : '#FFFFFF');
                        broadcastEffect(room.id, 'particle', { x: ship.x, y: ship.y, color: '#FF0000', count: 12 });
                        broadcastEffect(room.id, 'flash', { color: '#FF0000', intensity: 0.3 });
                    }

                    room.bullets.splice(i, 1);
                    bulletHit = true;
                    break;
                }
            }
        }

        if (bulletHit) continue;

        // Bullet-Asteroid collisions
        for (let j = room.asteroids.length - 1; j >= 0; j--) {
            const asteroid = room.asteroids[j];
            const dist = Math.hypot(bullet.x - asteroid.x, bullet.y - asteroid.y);

            if (dist < asteroid.radius + 2) {
                asteroid.health -= bullet.damage;
                asteroid.flashUntil = Date.now() + 100;

                room.bullets.splice(i, 1);

                if (asteroid.health <= 0) {
                    handleAsteroidDestruction(room, asteroid, j);
                }

                broadcastEffect(room.id, 'particle', { x: asteroid.x, y: asteroid.y, color: '#FFFFFF', count: 6 });
                break;
            }
        }
    }

    // 2. Ship-to-Ship collisions (NEW for dual ship mode)
    if (room.ships && room.ships.blue && room.ships.pink) {
        const blueShip = room.ships.blue;
        const pinkShip = room.ships.pink;

        if (blueShip.alive && pinkShip.alive) {
            const dist = Math.hypot(blueShip.x - pinkShip.x, blueShip.y - pinkShip.y);
            const SHIP_SIZE = (blueShip.radius || 20) + (pinkShip.radius || 20);

            if (dist < SHIP_SIZE) {
                const blueShield = room.teamSystems.blue.shield.active;
                const pinkShield = room.teamSystems.pink.shield.active;
                const angle = Math.atan2(pinkShip.y - blueShip.y, pinkShip.x - blueShip.x);
                const angleBlue = angle * 180 / Math.PI;
                const anglePink = (angle + Math.PI) * 180 / Math.PI;

                // v3.17: Check if attacking shield hits enemy ship
                const blueAttackShieldHit = blueShield && blueShip.boosters.attackShield.active &&
                    isAngleInShieldArc(angleBlue, room.teamSystems.blue.shield.rotation, 72);
                const pinkAttackShieldHit = pinkShield && pinkShip.boosters.attackShield.active &&
                    isAngleInShieldArc(anglePink, room.teamSystems.pink.shield.rotation, 72);

                if (blueAttackShieldHit && !pinkShip.invulnerable) {
                    pinkShip.health = Math.max(0, pinkShip.health - 2);
                    broadcastEffect(room.id, 'particle', { x: pinkShip.x, y: pinkShip.y, color: '#FF00FF', count: 10 });
                }
                if (pinkAttackShieldHit && !blueShip.invulnerable) {
                    blueShip.health = Math.max(0, blueShip.health - 2);
                    broadcastEffect(room.id, 'particle', { x: blueShip.x, y: blueShip.y, color: '#FF00FF', count: 10 });
                }

                if (blueShield && pinkShield) {
                    // Both shields → repulsion, no damage
                    const repelForce = 2.0;
                    blueShip.vx -= Math.cos(angle) * repelForce;
                    blueShip.vy -= Math.sin(angle) * repelForce;
                    pinkShip.vx += Math.cos(angle) * repelForce;
                    pinkShip.vy += Math.sin(angle) * repelForce;

                    broadcastEffect(room.id, 'particle', { x: (blueShip.x + pinkShip.x) / 2, y: (blueShip.y + pinkShip.y) / 2, color: '#00FFFF', count: 20 });
                } else {
                    // At least one unshielded → both take damage
                    if (!blueShip.invulnerable && !blueShield) {
                        blueShip.health = Math.max(0, blueShip.health - 20);
                        broadcastEffect(room.id, 'particle', { x: blueShip.x, y: blueShip.y, color: '#FF0000', count: 15 });
                    }
                    if (!pinkShip.invulnerable && !pinkShield) {
                        pinkShip.health = Math.max(0, pinkShip.health - 20);
                        broadcastEffect(room.id, 'particle', { x: pinkShip.x, y: pinkShip.y, color: '#FF0000', count: 15 });
                    }

                    // Bounce apart
                    const angle = Math.atan2(pinkShip.y - blueShip.y, pinkShip.x - blueShip.x);
                    const bounceForce = 1.5;
                    blueShip.vx -= Math.cos(angle) * bounceForce;
                    blueShip.vy -= Math.sin(angle) * bounceForce;
                    pinkShip.vx += Math.cos(angle) * bounceForce;
                    pinkShip.vy += Math.sin(angle) * bounceForce;

                    broadcastEffect(room.id, 'shake', { intensity: 5 });
                }
            }
        }
    }

    // 3. Ship-Asteroid collisions
    for (const teamColor of teamColors) {
        const ship = ships[teamColor];
        if (!ship || !ship.alive) continue;

        const systems = room.teamSystems ? room.teamSystems[teamColor] : room.systems;

        for (let i = room.asteroids.length - 1; i >= 0; i--) {
            const asteroid = room.asteroids[i];
            const dist = Math.hypot(asteroid.x - ship.x, asteroid.y - ship.y);

            if (dist < (ship.radius || 20) + asteroid.radius) {
                const angleToAsteroid = Math.atan2(asteroid.y - ship.y, asteroid.x - ship.x) * 180 / Math.PI;

                // Check if shield blocks
                if (systems.shield.active && isAngleInShieldArc(angleToAsteroid, systems.shield.rotation, 72)) {
                    deflectAsteroid(asteroid, ship, systems.shield.rotation, room);

                    // v3.17: Attacking shield damages asteroids
                    if (ship.boosters.attackShield.active) {
                        asteroid.health = Math.max(0, asteroid.health - 2);
                        if (asteroid.health <= 0) {
                            handleAsteroidDestruction(room, asteroid, i);
                        }
                        broadcastEffect(room.id, 'particle', { x: asteroid.x, y: asteroid.y, color: '#FF00FF', count: 10 });
                    }
                } else {
                    // Impulse-based damage
                    const relativeSpeed = Math.hypot(asteroid.vx - ship.vx, asteroid.vy - ship.vy);
                    const sizeMultiplier = { large: 1.5, medium: 1.0, small: 0.5 }[asteroid.size];
                    const impulseDamage = Math.ceil(relativeSpeed * sizeMultiplier * 0.3);
                    const damage = Math.max(1, impulseDamage);

                    if (!ship.invulnerable) {
                        if (ship.hearts !== undefined) {
                            ship.hearts = Math.max(0, ship.hearts - damage);
                        }
                        if (ship.health !== undefined) {
                            ship.health = Math.max(0, ship.health - damage);
                        }
                        ship.lastDamageTime = Date.now();
                        ship.invulnerable = true;
                        ship.invulnerableUntil = Date.now() + 1000;

                        // Bounce asteroid
                        const angle = Math.atan2(asteroid.y - ship.y, asteroid.x - ship.x);
                        asteroid.vx = Math.cos(angle) * 3;
                        asteroid.vy = Math.sin(angle) * 3;

                        broadcastEffect(room.id, 'particle', { x: ship.x, y: ship.y, color: '#FF0000', count: 20 });
                        broadcastEffect(room.id, 'flash', { color: '#FF0000', intensity: 0.4 });
                        broadcastEffect(room.id, 'shake', { intensity: 6 });

                        // Check death (for legacy hearts system)
                        if (ship.hearts !== undefined && ship.hearts <= 0) {
                            room.gameOver = true;
                            room.winner = null;
                        }
                    }
                }
            }
        }
    }

    // 4. Ship-Coin collisions (both teams can collect)
    for (const teamColor of teamColors) {
        const ship = ships[teamColor];
        if (!ship || !ship.alive) continue;

        for (let i = room.coins.length - 1; i >= 0; i--) {
            const coin = room.coins[i];
            const dist = Math.hypot(coin.x - ship.x, coin.y - ship.y);

            if (dist < (ship.radius || 20) + 10) {
                ship.coins = (ship.coins || 0) + 1;
                room.coins.splice(i, 1);
                // Spawn new coin only if coinSpawn is enabled
                if (room.coinSpawn) {
                    room.coins.push(spawnCoin(room));
                }

                const teamColorHex = teamColor === 'blue' ? '#2196F3' : (teamColor === 'pink' ? '#E91E63' : '#FFD700');
                broadcastEffect(room.id, 'particle', { x: coin.x, y: coin.y, color: '#FFD700', count: 10 });
                broadcastEffect(room.id, 'scoreAnim', { x: ship.x, y: ship.y - (ship.radius || 20) - 20, text: '+1', color: teamColorHex });

                // Victory check moved to separate function
                break; // Only one ship can collect this coin
            }
        }
    }

    // 5. Ship-Heart collisions
    for (const teamColor of teamColors) {
        const ship = ships[teamColor];
        if (!ship || !ship.alive) continue;

        for (let i = room.hearts.length - 1; i >= 0; i--) {
            const heart = room.hearts[i];
            const dist = Math.hypot(heart.x - ship.x, heart.y - ship.y);

            if (dist < (ship.radius || 20) + 12) {
                if (ship.hearts !== undefined && ship.hearts < 10) {
                    ship.hearts = Math.min(10, ship.hearts + 1);
                    room.hearts.splice(i, 1);

                    broadcastEffect(room.id, 'particle', { x: heart.x, y: heart.y, color: '#FF1744', count: 15 });
                    broadcastEffect(room.id, 'flash', { color: '#FF1744', intensity: 0.2 });
                    break;
                }
                // Health restoration for dual ship mode
                if (ship.health !== undefined && ship.health < ship.maxHealth) {
                    ship.health = Math.min(ship.maxHealth, ship.health + 25);
                    room.hearts.splice(i, 1);

                    broadcastEffect(room.id, 'particle', { x: heart.x, y: heart.y, color: '#FF1744', count: 15 });
                    broadcastEffect(room.id, 'flash', { color: '#FF1744', intensity: 0.2 });
                    break;
                }
            }
        }
    }

    // v3.17: 6. Ship-Loot collisions
    for (const teamColor of teamColors) {
        const ship = ships[teamColor];
        if (!ship || !ship.alive) continue;

        for (let i = room.loot.length - 1; i >= 0; i--) {
            const loot = room.loot[i];
            const dist = Math.hypot(loot.x - ship.x, loot.y - ship.y);

            if (dist < (ship.radius || 20) + loot.radius) {
                applyLootEffect(room, ship, loot, teamColor);
                room.loot.splice(i, 1);
                break; // Only one ship can collect this loot
            }
        }
    }
}

// Check ship deaths and handle respawns
function checkShipDeathsAndRespawns(room) {
    if (!room.ships) return; // Only for dual ship mode

    ['blue', 'pink'].forEach(teamColor => {
        const ship = room.ships[teamColor];

        // Check if ship died
        if (ship.alive && ship.health <= 0) {
            ship.alive = false;
            const coinsToDrop = ship.coins || 0;
            ship.coins = 0;

            console.log(`[${teamColor}] Ship destroyed! Dropping ${coinsToDrop} coins`);

            // Drop all coins with scatter animation
            for (let i = 0; i < coinsToDrop; i++) {
                const angle = Math.random() * Math.PI * 2;
                const speed = 2 + Math.random() * 3;
                const distance = 30 + Math.random() * 50;

                room.coins.push({
                    x: ship.x + Math.cos(angle) * distance,
                    y: ship.y + Math.sin(angle) * distance,
                    vx: Math.cos(angle) * speed,
                    vy: Math.sin(angle) * speed,
                    radius: 10
                });
            }

            broadcastEffect(room.id, 'particle', { x: ship.x, y: ship.y, color: '#FFD700', count: coinsToDrop * 5 });
            broadcastEffect(room.id, 'flash', { color: '#FF0000', intensity: 0.8 });
            broadcastEffect(room.id, 'shake', { intensity: 10 });

            // Schedule respawn after 3 seconds
            ship.respawnTime = Date.now() + 3000;
        }

        // Check if it's time to respawn
        if (!ship.alive && ship.respawnTime && Date.now() >= ship.respawnTime) {
            // Respawn at fixed position
            ship.x = teamColor === 'blue' ? room.canvas.width * 0.25 : room.canvas.width * 0.75;
            ship.y = room.canvas.height / 2;
            ship.vx = 0;
            ship.vy = 0;
            ship.health = ship.maxHealth;
            ship.alive = true;
            ship.invulnerable = true;
            ship.invulnerableUntil = Date.now() + INVULNERABILITY_DURATION_MS; // 5s invulnerability
            ship.spawnTime = Date.now();
            ship.respawnTime = null;

            // v3.17: Reset boosters on respawn
            ship.boosters = {
                extraBullets: 0,
                laserSight: false,
                attackShield: { active: false, sizeBonus: 0 },
                attackEngine: { active: false, level: 0 }
            };

            console.log(`[${teamColor}] Ship respawned with 5s invulnerability`);

            const teamColorHex = teamColor === 'blue' ? '#2196F3' : '#E91E63';
            broadcastEffect(room.id, 'particle', { x: ship.x, y: ship.y, color: teamColorHex, count: 30 });
            broadcastEffect(room.id, 'flash', { color: teamColorHex, intensity: 0.5 });
        }

        // Clear invulnerability after timeout
        if (ship.invulnerable && Date.now() >= ship.invulnerableUntil) {
            ship.invulnerable = false;
            console.log(`[${teamColor}] Invulnerability ended`);
        }
    });
}

// Check team victory condition
function checkTeamVictory(room) {
    if (!room.ships) return; // Only for dual ship mode

    const blueCoins = room.ships.blue.coins || 0;
    const pinkCoins = room.ships.pink.coins || 0;
    const targetCoins = room.coinsToWin || 10;

    if (blueCoins >= targetCoins || pinkCoins >= targetCoins) {
        const winningTeam = blueCoins >= targetCoins ? 'blue' : 'pink';
        const winningTeamName = winningTeam === 'blue' ? 'Голубая команда' : 'Розовая команда';

        room.gameOver = true;
        room.winner = {
            team: winningTeamName,
            teamColor: winningTeam,
            blueScore: blueCoins,
            pinkScore: pinkCoins
        };

        console.log(`Victory! ${winningTeamName} wins with ${winningTeam === 'blue' ? blueCoins : pinkCoins} coins!`);

        // Broadcast game over
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.roomId === room.id) {
                client.send(JSON.stringify({
                    type: 'game_over',
                    winner: room.winner
                }));
            }
        });
    }
}

// Broadcast visual effect to all clients in a room
function broadcastEffect(roomId, effectType, data) {
    const message = JSON.stringify({
        type: 'effect',
        effectType: effectType,
        data: data
    });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.roomId === roomId) {
            client.send(message);
        }
    });
}

// Broadcast game state update to all clients in a room
function broadcastGameState(room) {
    const message = JSON.stringify({
        type: 'update',
        gameState: serializeGameState(room)
    });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.roomId === room.id) {
            client.send(message);
        }
    });
}

// Drop pizzas from dead snake body
function dropPizzasFromSnake(room, player) {
    const pizzasToDrop = player.score;

    if (pizzasToDrop === 0 || player.segments.length === 0) return;

    // Distribute pizzas along snake body
    for (let i = 0; i < pizzasToDrop; i++) {
        // Pick random segment from snake body
        const segmentIndex = Math.floor(Math.random() * player.segments.length);
        const segment = player.segments[segmentIndex];

        // Add random scatter offset (-20 to +20 pixels)
        const scatterX = (Math.random() - 0.5) * 40;
        const scatterY = (Math.random() - 0.5) * 40;

        const droppedPizza = {
            x: segment.x + scatterX,
            y: segment.y + scatterY,
            id: Date.now() + Math.random()
        };

        // Keep pizza within bounds
        droppedPizza.x = Math.max(room.pizzaSize, Math.min(room.canvas.width - room.pizzaSize, droppedPizza.x));
        droppedPizza.y = Math.max(room.pizzaSize, Math.min(room.canvas.height - BOUNDARY_MARGIN_BOTTOM - room.pizzaSize, droppedPizza.y));

        room.pizzas.push(droppedPizza);
    }

    console.log(`${player.name} dropped ${pizzasToDrop} pizzas`);
}

// Start lobby countdown for Ship game
function startLobbyCountdown(room) {
    if (room.lobbyCountdown) return; // Already running

    const COUNTDOWN_DURATION = 5000; // 5 seconds
    const startTime = Date.now();
    room.lobbyCountdownStart = startTime;

    console.log(`[LOBBY] Starting countdown in room ${room.id}`);

    // Send countdown to all clients in the room (display and controllers)
    const countdownMessage = JSON.stringify({
        type: 'lobby_countdown',
        startTime: startTime,
        duration: COUNTDOWN_DURATION
    });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.roomId === room.id) {
            client.send(countdownMessage);
        }
    });

    // Timer for server-side countdown completion
    room.lobbyCountdown = setTimeout(() => {
        room.lobbyCountdown = null;
        room.lobbyCountdownStart = null;
        room.gameStarted = true;
        console.log(`[LOBBY] Game started in room ${room.id}`);

        // Activate ship invulnerability for 5 seconds at round start
        if (room.ship) {
            room.ship.invulnerable = true;
            room.ship.invulnerableUntil = Date.now() + 5000; // 5 seconds
            room.ship.spawnTime = Date.now(); // Track spawn time for blinking animation
            console.log(`[SHIP] Invulnerability activated for 5 seconds`);
        }

        // Send start_calibration to all controllers
        room.players.forEach((player) => {
            if (player.ws && player.ws.readyState === 1) {
                player.ws.send(JSON.stringify({
                    type: 'start_calibration'
                }));
            }
        });

        broadcastGameState(room);
    }, COUNTDOWN_DURATION);
}

// Cancel lobby countdown
function cancelLobbyCountdown(room) {
    if (!room.lobbyCountdown) return; // No countdown running

    clearTimeout(room.lobbyCountdown);
    room.lobbyCountdown = null;
    room.lobbyCountdownStart = null;

    console.log(`[LOBBY] Countdown cancelled in room ${room.id}`);

    // Notify all clients in the room (display and controllers)
    const cancelMessage = JSON.stringify({
        type: 'lobby_countdown_cancelled'
    });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.roomId === room.id) {
            client.send(cancelMessage);
        }
    });
}

// Handle WebSocket connections
wss.on('connection', (ws) => {
    console.log('Client connected');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'create_room') {
                // Create new room with game type and settings
                const roomId = generateRoomId();
                const gameType = data.gameType || 'snake';
                const settings = data.settings || {};
                createRoom(roomId, gameType, settings);

                ws.send(JSON.stringify({
                    type: 'room_created',
                    roomId: roomId
                }));

                console.log(`Room ${roomId} created by display (${gameType})`);

            } else if (data.type === 'join') {
                const roomId = data.roomId;
                const gameType = data.gameType || 'snake';
                const sessionToken = data.sessionToken; // Optional: client sends token if reconnecting

                console.log(`[JOIN] Received join request: room=${roomId}, gameType=${gameType}, player=${data.name}, token=${sessionToken ? sessionToken.substring(0, 8) + '...' : 'none'}`);

                // CHECK FOR RECONNECTION
                if (sessionToken && disconnectedPlayers.has(sessionToken)) {
                    const disconnectData = disconnectedPlayers.get(sessionToken);
                    const room = rooms.get(disconnectData.roomId);

                    // Verify room still exists and player is still in room
                    if (room && room.players.has(disconnectData.playerId)) {
                        const player = room.players.get(disconnectData.playerId);

                        // Restore WebSocket connection
                        player.ws = ws;
                        ws.playerId = disconnectData.playerId;
                        ws.roomId = disconnectData.roomId;

                        // Remove from disconnected list
                        disconnectedPlayers.delete(sessionToken);

                        console.log(`[RECONNECT] Player ${player.name} reconnected to room ${room.id} (role: ${player.systemRole || 'none'})`);

                        // Send init message with reconnection flag
                        ws.send(JSON.stringify({
                            type: 'init',
                            playerId: player.id,
                            roomId: room.id,
                            sessionToken: sessionToken, // Send back same token
                            reconnected: true, // Flag to client that this was a reconnection
                            gameState: serializeGameState(room),
                            gameStarted: room.gameStarted
                        }));

                        // Broadcast updated state (player no longer disconnected/autopilot)
                        broadcastGameState(room);

                        return; // Done with reconnection
                    } else {
                        // Room or player no longer exists - proceed as new join
                        console.log(`[RECONNECT] Token found but room/player no longer exists, creating new player`);
                        disconnectedPlayers.delete(sessionToken);
                    }
                }

                // NORMAL JOIN FLOW (new player or failed reconnection)
                // Create room if it doesn't exist
                if (!rooms.has(roomId)) {
                    console.log(`[JOIN] Creating new room: ${roomId}`);
                    createRoom(roomId, gameType);
                }

                const room = rooms.get(roomId);
                console.log(`[JOIN] Room found, current players: ${room.players.size}, gameType: ${room.gameType}`);

                // For Pong: limit to 2 players
                if (room.gameType === 'pong' && room.players.size >= 2) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Room is full (max 2 players for Pong)'
                    }));
                    return;
                }

                // For Ballz: single player only
                if (room.gameType === 'ballz' && room.players.size >= 1) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Room is full (Ballz is single-player only)'
                    }));
                    return;
                }

                const playerId = Date.now() + '-' + Math.random();
                const newSessionToken = generateSessionToken(); // Generate token for new player

                // Initialize player based on game type
                const player = {
                    id: playerId,
                    name: data.name || `Player ${room.players.size + 1}`,
                    color: getRandomColor(room),  // Pass room to ensure unique colors
                    score: 0,
                    tilt: 0.5,
                    ws: ws,
                    sessionToken: newSessionToken // Store session token on player for reconnection
                };

                if (room.gameType === 'pong') {
                    // Pong: paddle position (left or right)
                    const isPlayer1 = room.players.size === 0;
                    player.paddleY = room.canvas.height / 2 - room.paddleSize / 2;
                    player.paddleX = isPlayer1 ? 20 : room.canvas.width - 30;
                    player.side = isPlayer1 ? 'left' : 'right';
                    player.alive = true; // Pong players are always alive (no death mechanic)
                } else if (room.gameType === 'pushers') {
                    // Pushers: axis-locked movement
                    const team = data.team || 'White';
                    let assignedTeam = team;
                    let axis;

                    // Single-square mode: auto-assign teams and roles
                    if (room.settings && room.settings.singleSquare) {
                        const teamColors = ['Blue', 'Red', 'Yellow', 'Green', 'White'];
                        const teamIndex = Math.floor(room.nextPlayerId / 2);
                        assignedTeam = teamColors[teamIndex % 5];

                        // Determine axis based on position within team (0 = X, 1 = Y)
                        const roleInTeam = room.nextPlayerId % 2;
                        axis = roleInTeam === 0 ? 'X' : 'Y';
                        player.role = roleInTeam === 0 ? 'controller-x' : 'controller-y';
                    } else {
                        // Normal mode: alternate axis
                        axis = room.nextPlayerId % 2 === 0 ? 'X' : 'Y';
                    }

                    room.nextPlayerId++;

                    const spawnPos = spawnPlayerSquare(room, axis);

                    player.team = assignedTeam;
                    player.color = getTeamColor(assignedTeam);
                    player.axis = axis;
                    player.x = spawnPos.x;
                    player.y = spawnPos.y;
                    player.alive = true;
                } else if (room.gameType === 'ship') {
                    // Ship: player starts as observer (no role or team assigned)
                    player.team = null;           // Team selection required before role selection
                    player.systemRole = null;
                    player.systemIndex = null;
                    player.lastTilt = undefined;  // Previous tilt value (undefined allows proper first pump detection)
                    player.alive = true;          // All players share ship health
                    player.ready = false;         // Player hasn't pressed "Ready" button yet

                    console.log(`Player ${player.name} joined as observer (no role assigned)`);
                } else if (room.gameType === 'ballz') {
                    // Ballz v3.25.0: Single-player arcade
                    player.score = 0;
                    player.ballCount = 1;
                    player.turnNumber = 0;
                    player.alive = true;
                    player.gameOver = false;

                    // State machine: aiming → charging → launching → balls_in_flight → turn_complete
                    player.turnState = 'aiming';

                    // Aiming & charging
                    player.aimAngle = Math.PI / 2; // 90° up
                    player.lastTilt = null;
                    player.chargeStartTime = null;
                    player.chargeProgress = 0;
                    player.isInDeadZone = false;

                    // Launch position (relative 0-1, null = center)
                    player.launchX = null;

                    // Flying balls
                    player.balls = [];

                    // Field (relative coordinates 0-1)
                    player.blocks = []; // [{gridX, gridY, hp, maxHp}]
                    player.bonusBalls = []; // [{gridX, gridY}]

                    // Spawn initial blocks
                    ballzSpawnBlocks(player, room);

                    console.log(`Player ${player.name} joined Ballz game`);
                } else {
                    // Snake: segments and position
                    player.alive = true;
                    player.segments = [];
                    player.angle = 0;
                    player.targetAngle = 0;  // For arrow_steering control scheme
                    player.headX = room.canvas.width / 2 + (Math.random() - 0.5) * 200;
                    player.headY = room.canvas.height / 2 + (Math.random() - 0.5) * 200;
                    player.controlScheme = data.controlScheme || 'arrow_instant';  // Store per-player control

                    // Initialize snake segments using room's segment size
                    for (let i = 0; i < INITIAL_LENGTH; i++) {
                        player.segments.push({
                            x: player.headX - i * room.segmentSize,
                            y: player.headY
                        });
                    }
                }

                room.players.set(playerId, player);
                ws.playerId = playerId;
                ws.roomId = roomId;

                // For Pong: start game when 2 players join
                if (room.gameType === 'pong' && room.players.size === 2) {
                    room.gameStarted = true;
                    console.log(`Pong game starting in room ${roomId} with 2 players`);
                }

                // Send initial state to new player (with session token)
                const initMessage = {
                    type: 'init',
                    playerId: playerId,
                    roomId: roomId,
                    sessionToken: newSessionToken, // Send token to client for reconnection
                    gameState: serializeGameState(room),
                    gameStarted: room.gameStarted // Include gameStarted flag for reconnect handling
                };
                console.log(`[JOIN] Sending init message to ${player.name}:`, JSON.stringify(initMessage).substring(0, 100) + '...');
                ws.send(JSON.stringify(initMessage));

                console.log(`[JOIN] Player ${playerId} joined room ${roomId} as ${player.name} (${room.gameType})`);

            } else if (data.type === 'join_room') {
                // Display wants to join existing room as spectator
                const roomId = data.roomId;

                // Check if room exists
                if (!rooms.has(roomId)) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: `Комната ${roomId} не найдена`
                    }));
                    console.log(`[JOIN_ROOM] Room ${roomId} not found`);
                    return;
                }

                const room = rooms.get(roomId);
                ws.roomId = roomId;
                ws.isDisplay = true;

                // Send current game state to the joining display
                ws.send(JSON.stringify({
                    type: 'room_joined',
                    roomId: roomId,
                    gameType: room.gameType,
                    gameState: serializeGameState(room)
                }));

                console.log(`[JOIN_ROOM] Display joined room ${roomId} as spectator`);

            } else if (data.type === 'join_display') {
                const roomId = data.roomId;
                const gameType = data.gameType || 'snake';

                // Create room if it doesn't exist
                if (!rooms.has(roomId)) {
                    createRoom(roomId, gameType, data.settings || {});
                }

                ws.roomId = roomId;
                ws.isDisplay = true;

                const room = rooms.get(roomId);
                room.displayWs = ws; // Save display WebSocket for migration

                // Apply settings from display (if provided and room already existed)
                if (data.settings) {
                    room.settings = data.settings;

                    // Update winScore if provided in settings
                    if (data.settings.winScore) {
                        room.winScore = data.settings.winScore;
                    }

                    console.log(`Applied settings to room ${roomId}:`, data.settings);
                }

                ws.send(JSON.stringify({
                    type: 'init',
                    roomId: roomId,
                    gameState: serializeGameState(room)
                }));

                console.log(`Display joined room ${roomId}`);

            } else if (data.type === 'input' && ws.playerId && ws.roomId) {
                // Update player tilt
                const room = rooms.get(ws.roomId);
                if (room) {
                    const player = room.players.get(ws.playerId);
                    if (player) {
                        // For Pong, always update. For Snake, only if alive.
                        if (room.gameType === 'pong' || player.alive) {
                            player.tilt = data.tilt;
                        }
                    }
                }
            } else if (data.type === 'update_physics' && data.roomId) {
                // Update live physics settings for Ship game
                const room = rooms.get(data.roomId);
                if (room && room.gameType === 'ship' && data.physics) {
                    room.physics = data.physics;
                    console.log(`Physics updated in room ${data.roomId}:`, data.physics);
                }
            } else if (data.type === 'ping') {
                // Keepalive ping - respond with pong
                ws.send(JSON.stringify({ type: 'pong' }));
            } else if (data.type === 'respawn' && ws.playerId && ws.roomId) {
                // Respawn dead player
                const room = rooms.get(ws.roomId);
                if (room && room.gameType === 'snake') {
                    const player = room.players.get(ws.playerId);
                    if (player && !player.alive) {
                        // Reset player state
                        player.alive = true;
                        player.score = 0;
                        player.angle = 0;
                        player.targetAngle = 0;  // Reset target angle for arrow_steering
                        player.headX = room.canvas.width / 2 + (Math.random() - 0.5) * 200;
                        player.headY = room.canvas.height / 2 + (Math.random() - 0.5) * 200;

                        // Restore control scheme if provided
                        if (data.controlScheme) {
                            player.controlScheme = data.controlScheme;
                        }

                        // Reset segments
                        player.segments = [];
                        for (let i = 0; i < INITIAL_LENGTH; i++) {
                            player.segments.push({
                                x: player.headX - i * room.segmentSize,
                                y: player.headY
                            });
                        }

                        console.log(`Player ${player.id} respawned with control: ${player.controlScheme}`);
                    }
                }
            } else if (data.type === 'change_control' && ws.playerId && ws.roomId) {
                // Handle control scheme change during gameplay
                const room = rooms.get(ws.roomId);
                if (room && room.gameType === 'snake') {
                    const player = room.players.get(ws.playerId);
                    if (player) {
                        player.controlScheme = data.controlScheme || 'arrow_instant';
                        console.log(`Player ${player.id} changed control to ${player.controlScheme}`);
                    }
                }
            } else if (data.type === 'change_role' && ws.playerId && ws.roomId) {
                // Handle role change for Ship game
                console.log(`[CHANGE_ROLE] Received from player ${ws.playerId}, role: ${data.role}`);
                const room = rooms.get(ws.roomId);
                if (room && room.gameType === 'ship') {
                    const player = room.players.get(ws.playerId);
                    if (!player) {
                        console.log(`[CHANGE_ROLE] ERROR: Player ${ws.playerId} not found in room`);
                        return;
                    }

                    const requestedRole = data.role; // 'engine' | 'rudder' | 'weapon' | 'weaponDirection' | 'shield' | null
                    console.log(`[CHANGE_ROLE] Player ${player.name} requesting role: ${requestedRole}`);

                    // Player must have team selected before choosing role
                    if (!player.team) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Выберите команду перед выбором роли'
                        }));
                        return;
                    }

                    // If player wants to release role
                    if (requestedRole === null) {
                        player.systemRole = null;
                        player.systemIndex = null;
                        console.log(`Player ${player.name} released their role`);
                        broadcastGameState(room);
                        return;
                    }

                    // Check if role is already taken BY SOMEONE ON THE SAME TEAM
                    const roleTaken = Array.from(room.players.values()).some(p =>
                        p.id !== player.id &&
                        p.team === player.team &&
                        p.systemRole === requestedRole
                    );

                    if (roleTaken) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Эта роль уже занята другим игроком в вашей команде'
                        }));
                        return;
                    }

                    // Assign role
                    const systems = ['engine', 'rudder', 'weapon', 'weaponDirection', 'shield'];
                    player.systemRole = requestedRole;
                    console.log(`[CHANGE_ROLE] SUCCESS: ${player.name} assigned to role ${requestedRole}`);
                    player.systemIndex = systems.indexOf(requestedRole) + 1; // 1-5

                    console.log(`Player ${player.name} assigned to system: ${player.systemRole}`);
                    broadcastGameState(room);
                }
            } else if (data.type === 'select_team' && ws.playerId && ws.roomId) {
                // Handle team selection for Ship game
                const room = rooms.get(ws.roomId);
                if (room && room.gameType === 'ship') {
                    const player = room.players.get(ws.playerId);
                    if (!player) return;

                    const requestedTeam = data.team; // 'blue' | 'pink'

                    // Validate team choice
                    if (requestedTeam !== 'blue' && requestedTeam !== 'pink') {
                        console.log(`[TEAM] Invalid team selection: ${requestedTeam}`);
                        return;
                    }

                    // Cannot change team during active game
                    if (room.gameState === 'playing') {
                        console.log(`[TEAM] ${player.name} tried to change team during game`);
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Нельзя менять команду во время игры'
                        }));
                        return;
                    }

                    // Update player team
                    player.team = requestedTeam;
                    console.log(`[TEAM] ${player.name} selected team: ${requestedTeam}`);

                    // Reset ready status on team change
                    if (player.ready) {
                        player.ready = false;
                        console.log(`[TEAM] ${player.name} ready status reset due to team change`);
                    }

                    // Broadcast updated game state
                    broadcastGameState(room);
                }
            } else if (data.type === 'player_ready' && ws.playerId && ws.roomId) {
                // Handle player ready status for Ship game
                const room = rooms.get(ws.roomId);
                if (room && room.gameType === 'ship') {
                    const player = room.players.get(ws.playerId);
                    if (!player) return;

                    // Player must have a role to be ready
                    if (!player.systemRole) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Выберите роль перед началом игры'
                        }));
                        return;
                    }

                    player.ready = true;
                    console.log(`Player ${player.name} is ready`);

                    // Check if all players are ready
                    const allReady = Array.from(room.players.values()).every(p => p.ready);
                    if (allReady && room.players.size > 0) {
                        console.log(`[LOBBY] All players ready in room ${room.id}, starting countdown`);
                        startLobbyCountdown(room);
                    }

                    broadcastGameState(room);
                }
            } else if (data.type === 'player_unready' && ws.playerId && ws.roomId) {
                // Handle player unready status for Ship game
                const room = rooms.get(ws.roomId);
                if (room && room.gameType === 'ship') {
                    const player = room.players.get(ws.playerId);
                    if (!player) return;

                    player.ready = false;
                    console.log(`[LOBBY] Player ${player.name} is no longer ready`);

                    // Cancel countdown if it was running
                    cancelLobbyCountdown(room);

                    broadcastGameState(room);
                }
            } else if (data.type === 'restart_game' && ws.roomId) {
                // Restart the same game
                const room = rooms.get(ws.roomId);
                if (room && room.gameOver) {
                    const preserveRoles = data.preserveRoles !== false; // default true
                    resetRoomForReplay(room, preserveRoles);

                    // Broadcast to all clients in room
                    broadcastToRoom(room.id, {
                        type: 'game_restarted',
                        preserveRoles: preserveRoles,
                        gameType: room.gameType
                    });

                    // Send updated game state
                    if (room.gameType === 'ship') {
                        // For Ship: use broadcastGameState to include lobby/game state
                        broadcastGameState(room);
                    } else {
                        // For other games: send update message
                        broadcastToRoom(room.id, {
                            type: 'update',
                            gameState: serializeGameState(room)
                        });
                    }

                    console.log(`[REPLAY] Room ${room.id} restarted (preserveRoles: ${preserveRoles})`);
                }
            } else if (data.type === 'request_game_change' && ws.roomId && ws.isDisplay) {
                // Request to change game (Display only)
                const room = rooms.get(ws.roomId);
                if (room) {
                    // Send to Display to show game selection screen
                    ws.send(JSON.stringify({
                        type: 'show_game_selection'
                    }));

                    console.log(`[REPLAY] Display requested game change in room ${room.id}`);
                }
            } else if (data.type === 'confirm_game_change' && ws.roomId && ws.isDisplay) {
                // Confirm game change and migrate to new game
                const room = rooms.get(ws.roomId);
                if (room) {
                    const result = migrateRoomToNewGame(room, data.gameType, data.settings || {});

                    // Broadcast to all clients (including Display)
                    broadcastToRoom(result.newRoomId, {
                        type: 'room_migrated',
                        newRoomId: result.newRoomId,
                        newGameType: data.gameType
                    });

                    // Send Display-specific message for QR code update
                    ws.send(JSON.stringify({
                        type: 'update_qr_code',
                        roomId: result.newRoomId,
                        gameType: data.gameType
                    }));

                    // Send initial game state to all clients
                    if (data.gameType === 'ship') {
                        // For Ship: send lobby state
                        broadcastGameState(result.newRoom);
                    } else {
                        // For other games: send game state
                        broadcastToRoom(result.newRoomId, {
                            type: 'update',
                            gameState: serializeGameState(result.newRoom)
                        });
                    }

                    console.log(`[REPLAY] Migrated to ${data.gameType}, new room: ${result.newRoomId}`);
                }
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });

    ws.on('close', () => {
        if (ws.playerId && ws.roomId) {
            const room = rooms.get(ws.roomId);
            if (room) {
                const player = room.players.get(ws.playerId);

                if (player) {
                    console.log(`Player ${player.name} disconnected from room ${ws.roomId}`);

                    // Save player to disconnected list for reconnection
                    if (player.sessionToken) {
                        const playerData = {
                            id: player.id,
                            name: player.name,
                            color: player.color,
                            score: player.score,
                            team: player.team,
                            systemRole: player.systemRole,
                            systemIndex: player.systemIndex,
                            ready: player.ready,
                            controlScheme: player.controlScheme,
                            // Game-specific data
                            paddleY: player.paddleY,
                            paddleX: player.paddleX,
                            side: player.side,
                            axis: player.axis,
                            x: player.x,
                            y: player.y,
                            segments: player.segments,
                            angle: player.angle,
                            targetAngle: player.targetAngle,
                            headX: player.headX,
                            headY: player.headY,
                            alive: player.alive,
                            lastTilt: player.lastTilt
                        };

                        disconnectedPlayers.set(player.sessionToken, {
                            roomId: ws.roomId,
                            playerId: ws.playerId,
                            disconnectTime: Date.now(),
                            playerData: playerData
                        });

                        console.log(`[RECONNECT] Player ${player.name} saved for reconnection (60s grace period)`);
                        console.log(`[RECONNECT] Role ${player.systemRole || 'none'} will remain active via autopilot`);
                    }

                    // For Ship game: handle lobby countdown cancellation
                    if (room.gameType === 'ship') {
                        // If player was ready in lobby, cancel countdown
                        if (!room.gameStarted && player.ready) {
                            console.log(`[LOBBY] Player ${player.name} was ready - cancelling countdown`);
                            cancelLobbyCountdown(room);
                        }

                        // Log role being freed (goes to autopilot)
                        if (player.systemRole) {
                            console.log(`[DISCONNECT] Role ${player.systemRole} will continue on autopilot`);
                        }
                    }

                    // DO NOT DELETE PLAYER - keep them in room for reconnection
                    // Player will be auto-removed after 60s grace period if they don't reconnect
                    // Autopilot will continue controlling their role

                    // Mark player as disconnected but keep in room
                    player.ws = null; // Clear WebSocket reference
                    broadcastGameState(room);
                }

                // Clean up empty rooms (only if NO players at all, including disconnected)
                if (room.players.size === 0 && !hasDisplayClient(ws.roomId)) {
                    clearInterval(room.gameLoopInterval);
                    rooms.delete(ws.roomId);
                    console.log(`Room ${ws.roomId} deleted (empty)`);
                }
            }
        }
    });
});

// Check if room has display client
function hasDisplayClient(roomId) {
    for (const client of wss.clients) {
        if (client.roomId === roomId && client.isDisplay) {
            return true;
        }
    }
    return false;
}

// Serialize game state for sending to clients
function serializeGameState(room) {
    const state = {
        gameType: room.gameType,
        canvas: room.canvas
    };

    if (room.gameType === 'pong') {
        // Pong state
        state.players = Array.from(room.players.values()).map(p => ({
            id: p.id,
            name: p.name,
            color: p.color,
            score: p.score,
            paddleY: p.paddleY,
            paddleX: p.paddleX,
            side: p.side
        }));
        state.ball = room.ball;
        state.paddleSize = room.paddleSize;
        state.winScore = room.winScore;
        state.gameStarted = room.gameStarted;
        state.gameOver = room.gameOver;
        state.winner = room.winner ? {
            id: room.winner.id,
            name: room.winner.name,
            score: room.winner.score
        } : null;
    } else if (room.gameType === 'pushers') {
        // Pushers state
        state.players = Array.from(room.players.values()).map(p => ({
            id: p.id,
            name: p.name,
            team: p.team,
            color: p.color,
            axis: p.axis,
            x: p.x,
            y: p.y,
            invulnerable: p.invulnerable || false
        }));
        state.teamScores = room.teamScores;
        state.smiley = room.smiley;
        state.skulls = room.skulls;
        state.ghosts = room.ghosts;
        state.squareSize = room.squareSize;
        state.smileySize = room.smileySize;
        state.skullSize = room.skullSize;
        state.ghostSize = room.ghostSize;
        state.singleSquareMode = (room.settings && room.settings.singleSquare) || false;
        state.winScore = room.winScore;
        state.gameOver = room.gameOver;
        state.winner = room.winner ? {
            team: room.winner.team,
            score: room.winner.score
        } : null;
    } else if (room.gameType === 'ship') {
        // Ship state - two team ships
        state.ships = {
            blue: {
                team: 'blue',
                x: room.ships.blue.x,
                y: room.ships.blue.y,
                radius: room.ships.blue.radius,
                vx: room.ships.blue.vx,
                vy: room.ships.blue.vy,
                rotation: room.ships.blue.rotation,
                health: room.ships.blue.health,
                maxHealth: room.ships.blue.maxHealth,
                coins: room.ships.blue.coins,
                lastDamageTime: room.ships.blue.lastDamageTime,
                invulnerable: room.ships.blue.invulnerable,
                invulnerableUntil: room.ships.blue.invulnerableUntil || 0,
                spawnTime: room.ships.blue.spawnTime || 0,
                alive: room.ships.blue.alive,
                boosters: room.ships.blue.boosters  // v3.17: Send boosters state
            },
            pink: {
                team: 'pink',
                x: room.ships.pink.x,
                y: room.ships.pink.y,
                radius: room.ships.pink.radius,
                vx: room.ships.pink.vx,
                vy: room.ships.pink.vy,
                rotation: room.ships.pink.rotation,
                health: room.ships.pink.health,
                maxHealth: room.ships.pink.maxHealth,
                coins: room.ships.pink.coins,
                lastDamageTime: room.ships.pink.lastDamageTime,
                invulnerable: room.ships.pink.invulnerable,
                invulnerableUntil: room.ships.pink.invulnerableUntil || 0,
                spawnTime: room.ships.pink.spawnTime || 0,
                alive: room.ships.pink.alive,
                boosters: room.ships.pink.boosters  // v3.17: Send boosters state
            }
        };

        // Send both team systems for dual ship mode
        state.teamSystems = {
            blue: room.teamSystems.blue,
            pink: room.teamSystems.pink
        };
        state.systems = room.systems; // Backward compatibility (points to blue)

        state.bullets = room.bullets.map(b => ({ x: b.x, y: b.y, id: b.id, team: b.team }));

        state.asteroids = room.asteroids.map(a => ({
            x: a.x, y: a.y, size: a.size, radius: a.radius,
            health: a.health, maxHealth: a.maxHealth,
            rotation: a.rotation, flashUntil: a.flashUntil, id: a.id
        }));

        state.coins = room.coins;
        state.hearts = room.hearts;
        state.loot = room.loot;  // v3.17: Send loot state

        state.players = Array.from(room.players.values()).map(p => ({
            id: p.id, name: p.name, color: p.color,
            team: p.team,  // NEW: team selection
            systemRole: p.systemRole, systemIndex: p.systemIndex, alive: p.alive,
            ready: p.ready
        }));

        state.thrustSystem = room.thrustSystem;
        state.engineFormula = room.engineFormula;
        state.coinsToWin = room.coinsToWin;
        state.asteroidFrequency = room.asteroidFrequency;
        state.autopilotEnabled = room.autopilotEnabled;

        // Send energy level for gradient system visualization
        state.energyLevel = room.thrustSystem === 'gradient' ? getEnergyLevel(room.systems.engine.energy) : 0;

        // Send weapon state for charging cone visualization
        state.weaponEnergy = room.systems.weapon.energy;        // 0-10 для визуализации
        state.weaponCharging = room.systems.weapon.isCharging; // true/false для конуса

        state.gameStarted = room.gameStarted;
        state.gameOver = room.gameOver;
        state.winner = room.winner;
    } else if (room.gameType === 'ballz') {
        // Ballz v3.25.0: Single-player with relative coordinates
        state.cols = room.cols;
        state.rows = room.rows;
        state.aspectRatio = room.aspectRatio;
        state.players = Array.from(room.players.values()).map(p => ({
            id: p.id,
            name: p.name,
            color: p.color,
            score: p.score,
            ballCount: p.ballCount,
            alive: p.alive,
            turnState: p.turnState,
            aimAngle: p.aimAngle,
            chargeProgress: p.chargeProgress,
            isInDeadZone: p.isInDeadZone,
            launchX: p.launchX,
            balls: p.balls, // Already relative coordinates
            blocks: p.blocks, // Already array with gridX, gridY
            bonusBalls: p.bonusBalls,
            turnNumber: p.turnNumber,
            gameOver: p.gameOver
        }));
        state.gameOver = room.gameOver;
        state.winner = room.winner;
    } else {
        // Snake state
        state.players = Array.from(room.players.values()).map(p => ({
            id: p.id,
            name: p.name,
            color: p.color,
            score: p.score,
            alive: p.alive,
            segments: p.segments,
            angle: p.angle,
            targetAngle: p.targetAngle || p.angle,  // For arrow_steering visualization
            controlScheme: p.controlScheme,  // For client-side rendering decisions
            respawnCountdown: p.respawnCountdown,  // Auto-respawn countdown
            respawnPosition: p.respawnPosition  // Where to respawn
        }));
        state.pizzas = room.pizzas;
        state.segmentSize = room.segmentSize;
        state.pizzaSize = room.pizzaSize;
        state.gameOver = room.gameOver;
        state.winner = room.winner ? {
            id: room.winner.id,
            name: room.winner.name,
            score: room.winner.score
        } : null;
    }

    return state;
}

// Update game state (60 FPS per room)
function gameLoop(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.gameType === 'pong') {
        updatePong(room);
    } else if (room.gameType === 'pushers') {
        updatePushers(room);
    } else if (room.gameType === 'ship') {
        updateShip(room);
    } else if (room.gameType === 'ballz') {
        ballzUpdate(room); // v3.25.0: New single-player implementation
    } else {
        updateSnake(room);
    }

    // Throttle broadcasts to 30 FPS (every 33ms) to reduce network load
    const now = Date.now();
    if (!room.lastBroadcast || now - room.lastBroadcast >= 33) {
        room.lastBroadcast = now;

        // Broadcast game state to all clients in this room
        const state = JSON.stringify({
            type: 'update',
            gameState: serializeGameState(room)
        });

        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.roomId === roomId) {
                client.send(state);
            }
        });
    }
}

// Update Snake game
function updateSnake(room) {
    // Update each player
    for (const player of room.players.values()) {
        // Handle respawn countdown for dead players
        if (!player.alive && player.respawnCountdown !== undefined) {
            player.respawnCountdown -= 1 / 60; // Countdown at 60 FPS

            if (player.respawnCountdown <= 0) {
                // Auto-respawn
                player.alive = true;
                player.score = 0; // Reset score
                player.angle = 0;
                player.targetAngle = 0;
                player.headX = player.respawnPosition.x;
                player.headY = player.respawnPosition.y;

                // Reset segments
                player.segments = [];
                for (let i = 0; i < INITIAL_LENGTH; i++) {
                    player.segments.push({
                        x: player.headX - i * room.segmentSize,
                        y: player.headY
                    });
                }

                // Clear countdown
                player.respawnCountdown = undefined;
                player.respawnPosition = undefined;

                console.log(`Player ${player.id} auto-respawned in room ${room.id}`);
            }
        }

        if (!player.alive) continue;

        // Calculate rotation from tilt with control mapping
        const circleRadius = 3 * room.segmentSize;
        const maxRotationSpeed = room.moveSpeed / circleRadius;
        const tiltDeviation = (player.tilt - 0.5) * 2; // -1 to 1

        // Apply control mapping curve (per-player)
        let mappedDeviation = tiltDeviation;

        switch (player.controlScheme || room.controlMapping || 'rotation_smooth') {
            case 'rotation_smooth':
                // Improved rotation mode: smoothing + reduced sensitivity
                const absSmooth = Math.abs(tiltDeviation);
                if (absSmooth < 0.15) {
                    // Small dead zone to filter sensor noise
                    mappedDeviation = 0;
                } else {
                    // Smooth ramp from dead zone
                    const normalized = (absSmooth - 0.15) / 0.85;
                    // Quadratic curve for smooth control
                    mappedDeviation = Math.sign(tiltDeviation) * (normalized * normalized * 0.7);
                }
                break;

            case 'rotation_linear':
                // Original linear mode (kept for advanced players)
                mappedDeviation = tiltDeviation;
                break;

            case 'center_straight':
                // Center position = straight ahead, edges = turning
                // Large dead zone in center (0.4-0.6 = straight)
                if (Math.abs(tiltDeviation) < 0.4) {
                    mappedDeviation = 0;
                } else {
                    // Remap edges to full range
                    const sign = Math.sign(tiltDeviation);
                    const absEdge = Math.abs(tiltDeviation);
                    const normalized = (absEdge - 0.4) / 0.6; // 0 to 1
                    mappedDeviation = sign * normalized;
                }
                break;

            case 'nonlinear_a':
                // Keep existing nonlinear_a (moderate curve)
                const absA = Math.abs(tiltDeviation);
                if (absA < 0.3) {
                    mappedDeviation = 0;
                } else {
                    const normalized = (absA - 0.3) / 0.7;
                    mappedDeviation = Math.sign(tiltDeviation) * (normalized * normalized);
                }
                break;

            case 'nonlinear_b':
                // Keep existing nonlinear_b (strong curve)
                const absB = Math.abs(tiltDeviation);
                if (absB < 0.4) {
                    mappedDeviation = 0;
                } else {
                    const normalized = (absB - 0.4) / 0.6;
                    mappedDeviation = Math.sign(tiltDeviation) * (normalized * normalized * normalized);
                }
                break;

            case 'fixed_updown': {
                // Fixed up-down control: absolute vertical intent
                // Up tilt = move toward top of screen, down tilt = toward bottom
                if (Math.abs(tiltDeviation) < 0.15) {
                    mappedDeviation = 0;
                    break;
                }

                // Determine if snake is facing right (0-180°) or left (180-360°)
                const angle = ((player.angle % (2 * Math.PI)) + (2 * Math.PI)) % (2 * Math.PI);
                const facingRight = angle < Math.PI;

                // When facing right: up-tilt = turn CCW (negative), down-tilt = turn CW (positive)
                // When facing left: REVERSE - up-tilt = turn CW (positive), down-tilt = turn CCW (negative)

                const tiltMagnitude = Math.abs(tiltDeviation);
                const normalizedTilt = (tiltMagnitude - 0.15) / 0.85;

                if (facingRight) {
                    // Moving right: normal behavior
                    mappedDeviation = tiltDeviation * normalizedTilt;
                } else {
                    // Moving left: FLIP the tilt direction for instant flip
                    mappedDeviation = -tiltDeviation * normalizedTilt;
                }

                break;
            }

            case 'arrow_steering': {
                // Абсолютное управление направлением (как руль корабля) с плавным поворотом
                // tilt can be -0.3 to 1.3 (30% overflow beyond calibrated range)
                player.targetAngle = player.tilt * 2 * Math.PI;

                // Плавная интерполяция к целевому углу
                let angleDiff = player.targetAngle - player.angle;

                // Нормализация к [-π, π] (кратчайший путь)
                while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
                while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

                // Интерполяция (15% за кадр)
                player.angle += angleDiff * 0.15;

                // Нормализация угла к [0, 2π]
                player.angle = ((player.angle % (2 * Math.PI)) + (2 * Math.PI)) % (2 * Math.PI);

                mappedDeviation = 0;
                break;
            }

            case 'arrow_instant': {
                // Послушная стрелка: мгновенный поворот по направлению наклона
                // tilt can be -0.3 to 1.3 (30% overflow beyond calibrated range)
                player.targetAngle = player.tilt * 2 * Math.PI;

                // Мгновенный поворот (змейка сразу смотрит туда куда указывает телефон)
                player.angle = player.targetAngle;

                mappedDeviation = 0;
                break;
            }

            default:
                // Default to rotation_smooth
                mappedDeviation = tiltDeviation * 0.7;
        }

        const rotationSpeed = mappedDeviation * maxRotationSpeed * 2.4 * room.turnSpeedMultiplier;

        // Update angle
        player.angle += rotationSpeed;

        // Move head
        player.headX += Math.cos(player.angle) * room.moveSpeed;
        player.headY += Math.sin(player.angle) * room.moveSpeed;

        // Wrap around screen
        const minX = 0;
        const maxX = room.canvas.width;
        const minY = 0;
        const maxY = room.canvas.height - BOUNDARY_MARGIN_BOTTOM;

        if (player.headX < minX) player.headX = maxX - 1;
        if (player.headX >= maxX) player.headX = minX;
        if (player.headY < minY) player.headY = maxY - 1;
        if (player.headY >= maxY) player.headY = minY;

        // Add new head segment
        player.segments.unshift({
            x: player.headX,
            y: player.headY
        });

        // Remove tail segment (growth based on settings: 1x/2x/4x/8x growth per pizza)
        const growthPerPizza = 3 * room.growthSpeed; // Base 3 segments × multiplier
        if (player.segments.length > INITIAL_LENGTH + player.score * growthPerPizza) {
            player.segments.pop();
        }
    }

    // Check collisions
    checkCollisions(room);
}

// ============================================================================
// BALLZ GAME LOGIC
// ============================================================================

// ============================================================================
// OLD Ballz v3.24.x functions REMOVED (480 lines)
// See new v3.25.0 single-player implementation at line ~4440
// ============================================================================

// Update Pong game
function updatePong(room) {
    // Update paddle positions based on tilt
    for (const player of room.players.values()) {
        // Map tilt (0-1) to paddle Y position
        // tilt 0 (bottom) -> paddle at bottom
        // tilt 1 (top) -> paddle at top
        const targetY = (1 - player.tilt) * (room.canvas.height - room.paddleSize);

        // Smooth movement
        player.paddleY += (targetY - player.paddleY) * 0.3;

        // Clamp position
        player.paddleY = Math.max(0, Math.min(room.canvas.height - room.paddleSize, player.paddleY));
    }

    // Don't update ball until game starts (need 2 players)
    if (!room.gameStarted) {
        return;
    }

    // Update ball position
    room.ball.x += room.ball.speedX;
    room.ball.y += room.ball.speedY;

    // Top and bottom wall collision
    if (room.ball.y - room.ball.radius < 0 || room.ball.y + room.ball.radius > room.canvas.height) {
        room.ball.speedY = -room.ball.speedY;
    }

    // Paddle collisions
    for (const player of room.players.values()) {
        const paddleWidth = 10;

        if (player.side === 'left') {
            // Left paddle collision
            if (room.ball.x - room.ball.radius < player.paddleX + paddleWidth &&
                room.ball.y > player.paddleY &&
                room.ball.y < player.paddleY + room.paddleSize &&
                room.ball.speedX < 0) {
                // Accelerate ball based on speedIncrease setting (1=5%, 2=15%, 3=30%)
                const increaseMultiplier = room.speedIncrease === 1 ? 1.05 : room.speedIncrease === 2 ? 1.15 : 1.30;
                const accelerated = Math.abs(room.ball.speedX) * increaseMultiplier;
                room.ball.speedX = Math.min(accelerated, room.ball.maxSpeedX);

                // Add angle based on hit position
                const hitPos = (room.ball.y - player.paddleY) / room.paddleSize;
                room.ball.speedY = (hitPos - 0.5) * 10;

                // Visual effects
                broadcastEffect(room.id, 'particle', { x: room.ball.x, y: room.ball.y, color: player.color, count: 12 });
                broadcastEffect(room.id, 'flash', { color: player.color, intensity: 0.2 });
                broadcastEffect(room.id, 'shake', { intensity: 2 });
            }
        } else {
            // Right paddle collision
            if (room.ball.x + room.ball.radius > player.paddleX &&
                room.ball.y > player.paddleY &&
                room.ball.y < player.paddleY + room.paddleSize &&
                room.ball.speedX > 0) {
                // Accelerate ball based on speedIncrease setting (1=5%, 2=15%, 3=30%)
                const increaseMultiplier = room.speedIncrease === 1 ? 1.05 : room.speedIncrease === 2 ? 1.15 : 1.30;
                const accelerated = Math.abs(room.ball.speedX) * increaseMultiplier;
                room.ball.speedX = -Math.min(accelerated, room.ball.maxSpeedX);

                const hitPos = (room.ball.y - player.paddleY) / room.paddleSize;
                room.ball.speedY = (hitPos - 0.5) * 10;

                // Visual effects
                broadcastEffect(room.id, 'particle', { x: room.ball.x, y: room.ball.y, color: player.color, count: 12 });
                broadcastEffect(room.id, 'flash', { color: player.color, intensity: 0.2 });
                broadcastEffect(room.id, 'shake', { intensity: 2 });
            }
        }
    }

    // Score points
    if (room.ball.x < 0) {
        // Right player scores
        const players = Array.from(room.players.values());
        const rightPlayer = players.find(p => p.side === 'right');
        if (rightPlayer) {
            rightPlayer.score++;
            console.log(`${rightPlayer.name} scored! Score: ${players[0]?.score || 0} - ${rightPlayer.score}`);

            // Visual effects for scoring
            broadcastEffect(room.id, 'particle', { x: room.ball.x, y: room.ball.y, color: rightPlayer.color, count: 20 });
            broadcastEffect(room.id, 'flash', { color: rightPlayer.color, intensity: 0.3 });
            broadcastEffect(room.id, 'shake', { intensity: 4 });
            broadcastEffect(room.id, 'scoreAnim', {
                x: room.canvas.width - 100,
                y: 30,
                text: '+1',
                color: rightPlayer.color
            });

            // Check for win condition
            if (rightPlayer.score >= room.winScore) {
                room.winner = rightPlayer;
                room.gameOver = true;
                console.log(`${rightPlayer.name} wins the game!`);
                return; // Don't reset ball, game is over
            }
        }
        resetBall(room);
    } else if (room.ball.x > room.canvas.width) {
        // Left player scores
        const players = Array.from(room.players.values());
        const leftPlayer = players.find(p => p.side === 'left');
        if (leftPlayer) {
            leftPlayer.score++;
            console.log(`${leftPlayer.name} scored! Score: ${leftPlayer.score} - ${players[1]?.score || 0}`);

            // Visual effects for scoring
            broadcastEffect(room.id, 'particle', { x: room.ball.x, y: room.ball.y, color: leftPlayer.color, count: 20 });
            broadcastEffect(room.id, 'flash', { color: leftPlayer.color, intensity: 0.3 });
            broadcastEffect(room.id, 'shake', { intensity: 4 });
            broadcastEffect(room.id, 'scoreAnim', {
                x: 100,
                y: 30,
                text: '+1',
                color: leftPlayer.color
            });

            // Check for win condition
            if (leftPlayer.score >= room.winScore) {
                room.winner = leftPlayer;
                room.gameOver = true;
                console.log(`${leftPlayer.name} wins the game!`);
                return; // Don't reset ball, game is over
            }
        }
        resetBall(room);
    }
}

// Reset ball to center (Pong)
function resetBall(room) {
    room.ball.x = room.canvas.width / 2;
    room.ball.y = room.canvas.height / 2;
    // Reset to base speed with random direction
    const direction = Math.random() > 0.5 ? 1 : -1;
    room.ball.speedX = room.ball.baseSpeedX * direction;
    room.ball.speedY = (Math.random() - 0.5) * 8;
}

// Update Pushers game
function updatePushers(room) {
    // Initialize ghost system for old rooms (backward compatibility)
    if (!room.ghosts) {
        room.ghosts = [];
        room.smileysCollected = 0;
        room.ghostSize = PUSHERS_SKULL_SIZE;
    }

    // Update player positions based on tilt and axis
    const fieldSize = room.canvas.width; // Square field
    const margin = room.squareSize / 2 + 10; // Unified margin (25px) - matches spawnPlayerSquare
    const settings = room.settings || {};

    if (settings.singleSquare) {
        // Single-square mode: combine X and Y controllers for each team
        const teamSquares = new Map(); // team -> {xController, yController}

        // Group players by team
        for (const player of room.players.values()) {
            if (!teamSquares.has(player.team)) {
                teamSquares.set(player.team, {});
            }
            const squad = teamSquares.get(player.team);
            if (player.axis === 'X') {
                squad.xController = player;
            } else {
                squad.yController = player;
            }
        }

        // Update positions based on combined input
        for (const [team, squad] of teamSquares.entries()) {
            const { xController, yController } = squad;

            if (xController && yController) {
                // Both controllers present - shared position
                const sharedX = margin + xController.tilt * (fieldSize - 2 * margin);
                const sharedY = margin + yController.tilt * (fieldSize - 2 * margin);

                xController.x = sharedX;
                xController.y = sharedY;
                yController.x = sharedX;
                yController.y = sharedY;
            } else if (xController && !yController) {
                // Only X controller - X axis only, Y stays at current
                const targetX = margin + xController.tilt * (fieldSize - 2 * margin);
                xController.x = targetX;
                xController.y = Math.max(margin, Math.min(fieldSize - margin, xController.y));
            } else if (yController && !xController) {
                // Only Y controller - Y axis only, X stays at current
                const targetY = margin + yController.tilt * (fieldSize - 2 * margin);
                yController.y = targetY;
                yController.x = Math.max(margin, Math.min(fieldSize - margin, yController.x));
            }
        }
    } else {
        // Normal mode: independent axis control
        for (const player of room.players.values()) {
            if (player.axis === 'X') {
                // Move only on X axis
                const targetX = margin + player.tilt * (fieldSize - 2 * margin);
                player.x = targetX;
                player.y = Math.max(margin, Math.min(fieldSize - margin, player.y));
            } else {
                // Move only on Y axis
                const targetY = margin + player.tilt * (fieldSize - 2 * margin);
                player.y = targetY;
                player.x = Math.max(margin, Math.min(fieldSize - margin, player.x));
            }
        }
    }

    // Check square-to-square collisions (push physics)
    // Using AABB (Axis-Aligned Bounding Box) collision detection
    const players = Array.from(room.players.values());
    const halfSize = room.squareSize / 2;

    for (let i = 0; i < players.length; i++) {
        for (let j = i + 1; j < players.length; j++) {
            const p1 = players[i];
            const p2 = players[j];

            // Calculate bounding boxes
            const p1Left = p1.x - halfSize;
            const p1Right = p1.x + halfSize;
            const p1Top = p1.y - halfSize;
            const p1Bottom = p1.y + halfSize;

            const p2Left = p2.x - halfSize;
            const p2Right = p2.x + halfSize;
            const p2Top = p2.y - halfSize;
            const p2Bottom = p2.y + halfSize;

            // AABB collision check
            const isColliding = p1Right > p2Left &&
                               p1Left < p2Right &&
                               p1Bottom > p2Top &&
                               p1Top < p2Bottom;

            if (isColliding) {
                // Determine push direction based on player axes and who is active pusher
                if (p1.axis === 'X' && p2.axis === 'Y') {
                    // p1 moves horizontally, p2 moves vertically
                    // p1 pushes p2 horizontally, p2 pushes p1 vertically

                    // p1 pushes p2 on X axis
                    if (p1.x < p2.x) {
                        p2.x = p1Right + halfSize;
                    } else {
                        p2.x = p1Left - halfSize;
                    }

                    // p2 pushes p1 on Y axis
                    if (p2.y < p1.y) {
                        p1.y = p2Bottom + halfSize;
                    } else {
                        p1.y = p2Top - halfSize;
                    }

                } else if (p1.axis === 'Y' && p2.axis === 'X') {
                    // p1 moves vertically, p2 moves horizontally
                    // p1 pushes p2 vertically, p2 pushes p1 horizontally

                    // p1 pushes p2 on Y axis
                    if (p1.y < p2.y) {
                        p2.y = p1Bottom + halfSize;
                    } else {
                        p2.y = p1Top - halfSize;
                    }

                    // p2 pushes p1 on X axis
                    if (p2.x < p1.x) {
                        p1.x = p2Right + halfSize;
                    } else {
                        p1.x = p2Left - halfSize;
                    }

                } else if (p1.axis === p2.axis) {
                    // Same axis - the one with higher tilt pushes the other
                    if (p1.axis === 'X') {
                        // Both move on X axis
                        if (p1.tilt > p2.tilt) {
                            // p1 has priority, pushes p2
                            if (p1.x < p2.x) {
                                p2.x = p1Right + halfSize;
                            } else {
                                p2.x = p1Left - halfSize;
                            }
                        } else {
                            // p2 has priority, pushes p1
                            if (p2.x < p1.x) {
                                p1.x = p2Right + halfSize;
                            } else {
                                p1.x = p2Left - halfSize;
                            }
                        }
                    } else {
                        // Both move on Y axis
                        if (p1.tilt > p2.tilt) {
                            // p1 has priority, pushes p2
                            if (p1.y < p2.y) {
                                p2.y = p1Bottom + halfSize;
                            } else {
                                p2.y = p1Top - halfSize;
                            }
                        } else {
                            // p2 has priority, pushes p1
                            if (p2.y < p1.y) {
                                p1.y = p2Bottom + halfSize;
                            } else {
                                p1.y = p2Top - halfSize;
                            }
                        }
                    }
                }
            }
        }
    }

    // Ensure all players stay within field bounds after collision resolution
    for (const player of room.players.values()) {
        player.x = Math.max(margin, Math.min(fieldSize - margin, player.x));
        player.y = Math.max(margin, Math.min(fieldSize - margin, player.y));
    }

    // Clear invulnerability after timeout
    for (const player of room.players.values()) {
        if (player.invulnerable && Date.now() >= player.invulnerableUntil) {
            player.invulnerable = false;
            delete player.invulnerableUntil;
        }
    }

    // Check smiley collection
    if (room.smiley) {
        for (const player of room.players.values()) {
            const dx = player.x - room.smiley.x;
            const dy = player.y - room.smiley.y;
            const distance = Math.hypot(dx, dy);

            if (distance < (room.squareSize / 2 + room.smileySize / 2)) {
                // Player collected smiley
                room.teamScores[player.team]++;
                room.smileysCollected++;
                console.log(`${player.name} (${player.team}) collected smiley! Score: ${room.teamScores[player.team]}`);

                // Visual effects for smiley collection
                broadcastEffect(room.id, 'particle', { x: room.smiley.x, y: room.smiley.y, color: '#FFEB3B', count: 15 });
                broadcastEffect(room.id, 'flash', { color: player.color, intensity: 0.2 });
                const teamIndex = ['Blue', 'Red', 'Yellow', 'Green', 'White'].indexOf(player.team);
                broadcastEffect(room.id, 'scoreAnim', {
                    x: 100, // Aligned with team scoreboard position
                    y: 15 + teamIndex * 20,
                    text: '+1',
                    color: player.color
                });

                // Spawn ghost every 3 smileys
                if (room.smileysCollected % 3 === 0) {
                    room.ghosts.push(spawnGhost(room));
                    console.log(`👻 Ghost spawned! Total ghosts: ${room.ghosts.length}`);
                }

                // Check win condition
                if (room.teamScores[player.team] >= room.winScore) {
                    room.winner = {
                        team: player.team,
                        score: room.teamScores[player.team]
                    };
                    room.gameOver = true;
                    console.log(`${player.team} team wins with ${room.teamScores[player.team]} smileys!`);
                    return;
                }

                // Spawn new smiley
                room.smiley = spawnSmiley(room);
            }
        }
    }

    // Update ghost positions and check wall bouncing
    for (const ghost of room.ghosts) {
        ghost.x += ghost.vx;
        ghost.y += ghost.vy;

        // Bounce off walls
        const margin = ghost.size / 2;
        if (ghost.x <= margin || ghost.x >= room.canvas.width - margin) {
            ghost.vx = -ghost.vx;
            ghost.x = Math.max(margin, Math.min(room.canvas.width - margin, ghost.x));
        }
        if (ghost.y <= margin || ghost.y >= room.canvas.height - margin) {
            ghost.vy = -ghost.vy;
            ghost.y = Math.max(margin, Math.min(room.canvas.height - margin, ghost.y));
        }
    }

    // Check ghost collision with players
    for (let i = room.ghosts.length - 1; i >= 0; i--) {
        const ghost = room.ghosts[i];
        for (const player of room.players.values()) {
            // Skip invulnerable players
            if (player.invulnerable) continue;

            const dx = player.x - ghost.x;
            const dy = player.y - ghost.y;
            const distance = Math.hypot(dx, dy);

            if (distance < (room.squareSize / 2 + ghost.size / 2)) {
                // Ghost hit player - same effect as skull
                room.teamScores[player.team] = Math.max(0, room.teamScores[player.team] - 1);
                console.log(`${player.name} (${player.team}) hit ghost! Score: ${room.teamScores[player.team]}`);

                // Visual effects for ghost collision
                broadcastEffect(room.id, 'particle', { x: player.x, y: player.y, color: '#9C27B0', count: 20 });
                broadcastEffect(room.id, 'flash', { color: '#9C27B0', intensity: 0.4 });
                broadcastEffect(room.id, 'shake', { intensity: 5 });
                const teamIndex = ['Blue', 'Red', 'Yellow', 'Green', 'White'].indexOf(player.team);
                broadcastEffect(room.id, 'scoreAnim', {
                    x: 100, // Aligned with team scoreboard position
                    y: 15 + teamIndex * 20,
                    text: '-1',
                    color: '#F44336'
                });

                // Respawn player at new position
                const newPos = spawnPlayerSquare(room, player.axis);
                player.x = newPos.x;
                player.y = newPos.y;

                // Add invulnerability period after respawn
                player.invulnerable = true;
                player.invulnerableUntil = Date.now() + 2000; // 2 seconds

                // Remove the ghost
                room.ghosts.splice(i, 1);
                console.log(`👻 Ghost removed! Remaining ghosts: ${room.ghosts.length}`);
                break;
            }
        }
    }

    // Check skull collision
    for (const player of room.players.values()) {
        // Skip invulnerable players
        if (player.invulnerable) continue;

        for (const skull of room.skulls) {
            const dx = player.x - skull.x;
            const dy = player.y - skull.y;
            const distance = Math.hypot(dx, dy);

            if (distance < (room.squareSize / 2 + room.skullSize / 2)) {
                // Player hit skull
                room.teamScores[player.team] = Math.max(0, room.teamScores[player.team] - 1);
                console.log(`${player.name} (${player.team}) hit skull! Score: ${room.teamScores[player.team]}`);

                // Visual effects for skull collision
                broadcastEffect(room.id, 'particle', { x: player.x, y: player.y, color: '#F44336', count: 20 });
                broadcastEffect(room.id, 'flash', { color: '#F44336', intensity: 0.4 });
                broadcastEffect(room.id, 'shake', { intensity: 5 });
                const teamIndex = ['Blue', 'Red', 'Yellow', 'Green', 'White'].indexOf(player.team);
                broadcastEffect(room.id, 'scoreAnim', {
                    x: 100, // Aligned with team scoreboard position
                    y: 15 + teamIndex * 20,
                    text: '-1',
                    color: '#F44336'
                });

                // Respawn player at new position
                const newPos = spawnPlayerSquare(room, player.axis);
                player.x = newPos.x;
                player.y = newPos.y;

                // Add invulnerability period after respawn
                player.invulnerable = true;
                player.invulnerableUntil = Date.now() + 2000; // 2 seconds
            }
        }
    }
}

// Update Ship game (60 FPS)
function updateShip(room) {
    // Process both teams independently
    ['blue', 'pink'].forEach(teamColor => {
        const systems = room.teamSystems[teamColor];
        const ship = room.ships[teamColor];

        if (!ship.alive) return;

        // Reset hasPlayer flags and shield active state
        systems.engine.hasPlayer = false;
        systems.weapon.hasPlayer = false;
        systems.shield.active = false;  // Shield only active when player controls it

        // 1. Update system states from team players
        const teamPlayers = Array.from(room.players.values()).filter(p => p.team === teamColor);

        for (const player of teamPlayers) {
            if (!player.systemRole) continue;

            const tilt = player.tilt;

            switch (player.systemRole) {
                case 'engine':
                    // Energy accumulation depends on thrust system
                    let energyAdded;
                    if (room.thrustSystem === 'gradient') {
                        energyAdded = calculateGradientEnergy(tilt, player.lastTilt);
                        systems.engine.energy = Math.min(systems.engine.energy + energyAdded, 750);
                        player.lastTilt = tilt;
                    } else {
                        energyAdded = detectPump(player, tilt, room);
                        systems.engine.energy = Math.min(systems.engine.energy + energyAdded, 10);
                    }
                    systems.engine.hasPlayer = true;
                    break;
                case 'rudder':
                    // tilt can be -0.3 to 1.3 (30% overflow beyond calibrated range)
                    systems.rudder.rotation = tilt * 360;
                    break;
                case 'weapon':
                    const weaponResult = updateWeaponCharge(player, tilt, room);

                    if (weaponResult.shouldFire && weaponResult.bulletCount > 0) {
                        fireBulletForTeam(room, teamColor);
                    } else {
                        systems.weapon.energy = weaponResult.newEnergy;
                    }

                    systems.weapon.hasPlayer = true;
                    break;
                case 'weaponDirection':
                    // tilt can be -0.3 to 1.3 (30% overflow beyond calibrated range)
                    systems.weaponDirection.rotation = tilt * 360;
                    break;
                case 'shield':
                    // tilt can be -0.3 to 1.3 (30% overflow beyond calibrated range)
                    systems.shield.rotation = tilt * 360;
                    systems.shield.active = true;
                    break;
            }
        }
    });

    // 2. Auto-rotate unoccupied systems for each team (only if autopilot enabled)
    if (room.autopilotEnabled) {
        ['blue', 'pink'].forEach(teamColor => {
            const systems = room.teamSystems[teamColor];
            const ship = room.ships[teamColor];

            if (!ship.alive) return;

            const teamPlayers = Array.from(room.players.values()).filter(p => p.team === teamColor);
            const occupied = new Set(teamPlayers.map(p => p.systemRole).filter(r => r !== null));

            if (!occupied.has('rudder')) {
                systems.rudder.rotation = (systems.rudder.rotation + 0.5) % 360;
            }
            if (!occupied.has('weaponDirection')) {
                systems.weaponDirection.rotation = (systems.weaponDirection.rotation - 0.7 + 360) % 360;
            }
            if (!occupied.has('weapon')) {
                // Auto-pilot: periodic auto-fire
            if (!room[`lastAutoWeaponFire_${teamColor}`]) room[`lastAutoWeaponFire_${teamColor}`] = Date.now();
            const timeSinceLastFire = Date.now() - room[`lastAutoWeaponFire_${teamColor}`];

            if (timeSinceLastFire > 1500) {
                systems.weapon.energy = 3.5;
                fireBulletForTeam(room, teamColor);
                room[`lastAutoWeaponFire_${teamColor}`] = Date.now();
            }

            systems.weapon.hasPlayer = true;
        }
        if (!occupied.has('engine')) {
            // Auto-pilot: constant minimal thrust
            if (room.thrustSystem === 'gradient') {
                // For gradient system: maintain energy around 150-300 (level 1-2)
                const targetEnergy = 150 + Math.random() * 150;
                if (systems.engine.energy < targetEnergy) {
                    systems.engine.energy = Math.min(systems.engine.energy + 2, targetEnergy);
                }
            } else {
                // For pump system: periodic small pumps
                if (!room[`lastAutoPump_${teamColor}`]) room[`lastAutoPump_${teamColor}`] = Date.now();
                const timeSinceLastPump = Date.now() - room[`lastAutoPump_${teamColor}`];

                if (timeSinceLastPump > 500) {
                    const burstEnergy = 0.5 + Math.random() * 1.5;
                    systems.engine.energy = Math.min(systems.engine.energy + burstEnergy, 10);
                    room[`lastAutoPump_${teamColor}`] = Date.now();
                }
            }

            systems.engine.hasPlayer = true;
        }
        // Shield always active
            if (!occupied.has('shield')) {
                systems.shield.active = true;
                systems.shield.rotation = (systems.shield.rotation + 0.3) % 360;
            } else {
                systems.shield.active = true;
            }
        });
    }

    // 3. Apply engine thrust and update positions for both ships
    ['blue', 'pink'].forEach(teamColor => {
        const ship = room.ships[teamColor];
        if (!ship.alive) return;

        applyEngineThrustForTeam(room, teamColor);
        updateShipPositionForTeam(room, teamColor);
    });

    // 5. Update bullets
    for (let i = room.bullets.length - 1; i >= 0; i--) {
        const bullet = room.bullets[i];
        bullet.x += bullet.vx;
        bullet.y += bullet.vy;
        bullet.distanceTraveled += Math.hypot(bullet.vx, bullet.vy);

        const margin = 100;
        if (bullet.distanceTraveled > bullet.maxDistance ||
            bullet.x < -margin || bullet.x > room.canvas.width + margin ||
            bullet.y < -margin || bullet.y > room.canvas.height + margin) {
            room.bullets.splice(i, 1);
        }
    }

    // 6. Update coins physics (for dropped coins with velocity)
    for (const coin of room.coins) {
        if (coin.vx !== undefined && coin.vy !== undefined) {
            coin.x += coin.vx;
            coin.y += coin.vy;

            // Friction to slow down dropped coins
            const COIN_FRICTION = 0.95;
            coin.vx *= COIN_FRICTION;
            coin.vy *= COIN_FRICTION;

            // Stop at very low speeds
            if (Math.abs(coin.vx) < 0.05) coin.vx = 0;
            if (Math.abs(coin.vy) < 0.05) coin.vy = 0;

            // Keep coins in bounds
            if (coin.x < 0) coin.x = 0;
            if (coin.x > room.canvas.width) coin.x = room.canvas.width;
            if (coin.y < 0) coin.y = 0;
            if (coin.y > room.canvas.height) coin.y = room.canvas.height;
        }
    }

    // v3.17: 6b. Update loot physics (same as coins)
    for (const loot of room.loot) {
        if (loot.vx !== undefined && loot.vy !== undefined) {
            loot.x += loot.vx;
            loot.y += loot.vy;

            // Friction to slow down loot
            const LOOT_FRICTION = 0.95;
            loot.vx *= LOOT_FRICTION;
            loot.vy *= LOOT_FRICTION;

            // Stop at very low speeds
            if (Math.abs(loot.vx) < 0.05) loot.vx = 0;
            if (Math.abs(loot.vy) < 0.05) loot.vy = 0;

            // Keep loot in bounds
            if (loot.x < 0) loot.x = 0;
            if (loot.x > room.canvas.width) loot.x = room.canvas.width;
            if (loot.y < 0) loot.y = 0;
            if (loot.y > room.canvas.height) loot.y = room.canvas.height;
        }
    }

    // 7. Spawn asteroids
    spawnAsteroidIfNeeded(room);

    // 8. Update asteroids
    for (const asteroid of room.asteroids) {
        asteroid.x += asteroid.vx;
        asteroid.y += asteroid.vy;
        asteroid.rotation += asteroid.rotationSpeed;
    }

    // v3.17: 8b. Attacking Engine auto-fire bullets
    ['blue', 'pink'].forEach(teamColor => {
        const ship = room.ships[teamColor];
        const systems = room.teamSystems[teamColor];

        if (ship.alive && ship.boosters.attackEngine.active && systems.engine.energy > 0) {
            const now = Date.now();
            const lastFire = ship.lastAttackEngineFire || 0;

            // Fire rate: 1000ms cooldown (1 shot/sec) - only when thrust active
            if (now - lastFire > 1000) {
                const level = ship.boosters.attackEngine.level;
                const bulletSize = 6 + (level - 1) * 0.5; // Size grows with level
                const bulletSpeed = 6 + level * 0.5; // Speed grows with level, faster than flame

                // Fire in SAME direction as engine thrust (opposite to rudder rotation)
                // Engine points one way, ship moves opposite, particles fly with engine
                const engineAngle = (systems.rudder.rotation + 180) * Math.PI / 180;
                const enginePos = getSystemPosition(ship, systems.rudder.rotation + 180);

                room.bullets.push({
                    x: enginePos.x,
                    y: enginePos.y,
                    vx: Math.cos(engineAngle) * bulletSpeed,
                    vy: Math.sin(engineAngle) * bulletSpeed,
                    damage: 3,
                    size: bulletSize,
                    powerLevel: 3,
                    distanceTraveled: 0,
                    maxDistance: 500,  // Fly farther than regular bullets
                    team: teamColor,
                    color: '#FFA500',  // Orange color like engine flame
                    id: Date.now() + Math.random()
                });

                ship.lastAttackEngineFire = now;

                broadcastEffect(room.id, 'particle', {
                    x: enginePos.x,
                    y: enginePos.y,
                    color: '#FFA500',  // Orange particles
                    count: 5
                });
            }
        }
    });

    // 9. Collision detection
    checkShipCollisions(room);

    // 10. Check ship deaths and respawns (dual ship mode)
    checkShipDeathsAndRespawns(room);

    // 10.5. Check team victory condition
    checkTeamVictory(room);

    // 11. Clear invulnerability (legacy single ship mode)
    if (room.ship && room.ship.invulnerable && Date.now() >= room.ship.invulnerableUntil) {
        room.ship.invulnerable = false;
    }

    // 11. Remove off-screen asteroids
    for (let i = room.asteroids.length - 1; i >= 0; i--) {
        const asteroid = room.asteroids[i];
        const margin = 150;
        if (asteroid.x < -margin || asteroid.x > room.canvas.width + margin ||
            asteroid.y < -margin || asteroid.y > room.canvas.height + margin) {
            room.asteroids.splice(i, 1);
        }
    }
}

// Check collisions
function checkCollisions(room) {
    for (const player of room.players.values()) {
        if (!player.alive) continue;

        const head = player.segments[0];

        // Check pizza collision
        for (let i = room.pizzas.length - 1; i >= 0; i--) {
            const pizza = room.pizzas[i];
            const dist = Math.hypot(head.x - pizza.x, head.y - pizza.y);

            if (dist < room.segmentSize / 2 + room.pizzaSize / 2) {
                // Ate pizza
                room.pizzas.splice(i, 1);
                player.score++;

                // Check for win condition
                const winScore = room.settings.winScore || 50;
                if (player.score >= winScore) {
                    room.winner = player;
                    room.gameOver = true;
                    console.log(`${player.name} wins with ${winScore} pizzas!`);
                }
            }
        }

        // REMOVED: Self-collision no longer kills snake - players can coil infinitely
        /*
        const minSegmentsForCollision = Math.ceil((2 * Math.PI * 3 * room.segmentSize) / room.segmentSize);
        for (let i = minSegmentsForCollision; i < player.segments.length; i++) {
            const seg = player.segments[i];
            const dist = Math.hypot(head.x - seg.x, head.y - seg.y);

            if (dist < room.segmentSize * 0.8) {
                player.alive = false;
                dropPizzasFromSnake(room, player);
                player.segments = [];  // Clear segments to prevent invisible collision
                console.log(`Player ${player.id} died (self-collision) in room ${room.id}`);
            }
        }
        */

        // Check collision with other players
        for (const otherPlayer of room.players.values()) {
            if (otherPlayer.id === player.id || !otherPlayer.alive) continue;

            // Check if player's head hits other player's body
            for (let i = 0; i < otherPlayer.segments.length; i++) {
                const seg = otherPlayer.segments[i];
                const dist = Math.hypot(head.x - seg.x, head.y - seg.y);

                if (dist < room.segmentSize * 0.8) {
                    // Player whose head collided dies
                    player.alive = false;
                    dropPizzasFromSnake(room, player);
                    player.segments = [];  // Clear segments to prevent invisible collision

                    // Auto-respawn countdown (3 seconds)
                    player.respawnCountdown = 3.0;
                    player.respawnPosition = {
                        x: Math.random() * room.canvas.width,
                        y: Math.random() * room.canvas.height
                    };

                    console.log(`Player ${player.id} died (hit ${otherPlayer.id}) in room ${room.id} - respawning in 3s`);
                    break;
                }
            }
        }
    }
}

// ==================== BALLZ v3.25.0 - Single Player ====================

/**
 * Ballz: Spawn initial blocks with relative coordinates
 * Blocks use grid positions (0 to cols-1, 0 to rows-1)
 */
function ballzSpawnBlocks(player, room) {
    const count = 1 + Math.floor(Math.random() * 5); // 1-5 blocks
    const availableCols = [];

    // Find empty columns in row 0
    for (let x = 0; x < room.cols; x++) {
        const hasBlock = player.blocks.some(b => b.gridX === x && b.gridY === 0);
        if (!hasBlock) {
            availableCols.push(x);
        }
    }

    // Leave at least 2 empty columns
    const maxSpawn = Math.max(0, availableCols.length - 2);
    if (maxSpawn === 0) return;

    // Shuffle and pick random columns
    shuffle(availableCols);
    const spawnCount = Math.min(count, maxSpawn);

    for (let i = 0; i < spawnCount; i++) {
        const gridX = availableCols[i];
        const hp = ballzCalculateBlockHP(player.turnNumber, room);

        player.blocks.push({
            gridX: gridX,
            gridY: 0,
            hp: hp,
            maxHp: hp
        });
    }
}

/**
 * Calculate block HP based on turn number and settings
 */
function ballzCalculateBlockHP(turnNumber, room) {
    const baseHP = 1 + Math.floor(turnNumber / room.hpIncreaseEveryN);
    const cappedHP = Math.min(baseHP, room.maxBlockHP);

    // Chance for lower HP
    if (Math.random() * 100 < room.lowerHPChance && cappedHP > 1) {
        return Math.max(1, cappedHP - Math.floor(Math.random() * 3 + 1));
    }

    return cappedHP;
}

/**
 * Main update function for Ballz game
 */
function ballzUpdate(room) {
    for (const player of room.players.values()) {
        if (!player.alive || player.gameOver) continue;

        ballzUpdatePlayer(room, player);
    }
}

/**
 * Update single player state machine
 */
function ballzUpdatePlayer(room, player) {
    switch (player.turnState) {
        case 'aiming':
            ballzUpdateAiming(room, player);
            break;
        case 'charging':
            ballzUpdateCharging(room, player);
            break;
        case 'launching':
            ballzUpdateLaunching(room, player);
            break;
        case 'balls_in_flight':
            ballzUpdatePhysics(room, player);
            ballzCheckCollisions(room, player);
            ballzCheckTurnComplete(room, player);
            break;
        case 'turn_complete':
            ballzAdvanceTurn(room, player);
            break;
    }
}

/**
 * AIMING state: Convert tilt to angle, check dead zones
 * CRITICAL: NO aimSensitivity - strict equality check
 */
function ballzUpdateAiming(room, player) {
    // Convert tilt (0-1) to angle (10° to 170°)
    const minAngle = 10 * Math.PI / 180;
    const maxAngle = 170 * Math.PI / 180;
    player.aimAngle = minAngle + player.tilt * (maxAngle - minAngle);

    // Check dead zones
    const deadZone = room.deadZoneSize;
    player.isInDeadZone = player.tilt < deadZone || player.tilt > (1 - deadZone);

    if (player.isInDeadZone) {
        // In dead zone - reset charge
        player.chargeStartTime = null;
        player.chargeProgress = 0;
        player.lastTilt = player.tilt;
        return;
    }

    // CRITICAL: Strict equality check - NO tolerance
    // Player must hold perfectly still to start charging
    if (player.lastTilt === null) {
        player.lastTilt = player.tilt;
        return;
    }

    if (player.tilt === player.lastTilt) {
        // Perfectly still - start charging
        if (!player.chargeStartTime) {
            player.chargeStartTime = Date.now();
            player.turnState = 'charging';
        }
    } else {
        // Moved - reset
        player.chargeStartTime = null;
    }

    player.lastTilt = player.tilt;
}

/**
 * CHARGING state: Track charge progress
 * CRITICAL: Strict movement check, dead zone resets charge
 */
function ballzUpdateCharging(room, player) {
    const elapsed = Date.now() - player.chargeStartTime;
    player.chargeProgress = Math.min(1, elapsed / room.chargeTime);

    // Check dead zones
    const deadZone = room.deadZoneSize;
    player.isInDeadZone = player.tilt < deadZone || player.tilt > (1 - deadZone);

    if (player.isInDeadZone) {
        // Moved into dead zone - reset
        player.turnState = 'aiming';
        player.chargeStartTime = null;
        player.chargeProgress = 0;
        return;
    }

    // CRITICAL: Strict equality - any movement resets
    if (player.tilt !== player.lastTilt) {
        // Moved - reset
        player.turnState = 'aiming';
        player.chargeStartTime = null;
        player.chargeProgress = 0;
        player.lastTilt = player.tilt;
        return;
    }

    // Full charge - launch
    if (player.chargeProgress >= 1) {
        player.turnState = 'launching';
        player.launchStartTime = Date.now();
    }

    player.lastTilt = player.tilt;
}

/**
 * LAUNCHING state: Spawn balls sequentially with delay
 */
function ballzUpdateLaunching(room, player) {
    const now = Date.now();
    const elapsed = now - player.launchStartTime;
    const shouldHaveLaunched = Math.floor(elapsed / room.ballLaunchDelay) + 1;
    const launchedCount = player.balls.length;

    if (launchedCount < shouldHaveLaunched && launchedCount < player.ballCount) {
        // Launch next ball
        const launchX = player.launchX !== null ? player.launchX : 0.5; // Center = 0.5
        const speed = room.ballSpeed / 100; // Convert to relative speed per frame

        player.balls.push({
            x: launchX, // Relative 0-1
            y: 1.0, // Bottom of field
            vx: Math.cos(player.aimAngle) * speed,
            vy: -Math.sin(player.aimAngle) * speed, // Negative = up
            active: true,
            isFirst: launchedCount === 0
        });
    }

    if (launchedCount >= player.ballCount) {
        player.turnState = 'balls_in_flight';
        player.firstBallReturned = false;
    }
}

/**
 * Update ball physics with relative coordinates
 */
function ballzUpdatePhysics(room, player) {
    const ballRadius = 0.01; // 1% of field width

    for (const ball of player.balls) {
        if (!ball.active) continue;

        ball.x += ball.vx;
        ball.y += ball.vy;

        // Wall bounces (left/right)
        if (ball.x <= ballRadius || ball.x >= 1 - ballRadius) {
            ball.vx = -ball.vx;
            ball.x = Math.max(ballRadius, Math.min(1 - ballRadius, ball.x));
        }

        // Top bounce
        if (ball.y <= ballRadius) {
            ball.vy = -ball.vy;
            ball.y = ballRadius;
        }

        // Bottom return (ball reaches launch line)
        if (ball.y >= 1.0) {
            ball.active = false;
            ball.y = 1.0;

            // First ball sets new launch position
            if (ball.isFirst && !player.firstBallReturned) {
                player.launchX = ball.x;
                player.firstBallReturned = true;
            }
        }
    }
}

/**
 * Check collisions between balls and blocks/bonuses
 */
function ballzCheckCollisions(room, player) {
    const ballRadius = 0.01;
    const blockWidth = 1.0 / room.cols;
    const blockHeight = 1.0 / room.rows;

    for (const ball of player.balls) {
        if (!ball.active) continue;

        // Block collisions
        for (let i = player.blocks.length - 1; i >= 0; i--) {
            const block = player.blocks[i];
            const blockCenterX = (block.gridX + 0.5) * blockWidth;
            const blockCenterY = (block.gridY + 0.5) * blockHeight;

            if (ballzCheckBallBlockCollision(ball, blockCenterX, blockCenterY, blockWidth, blockHeight, ballRadius)) {
                block.hp--;

                if (block.hp <= 0) {
                    player.blocks.splice(i, 1);
                    player.score++;
                }

                ballzReflectBall(ball, blockCenterX, blockCenterY, blockWidth, blockHeight);
                break;
            }
        }

        // Bonus ball pickups
        for (let i = player.bonusBalls.length - 1; i >= 0; i--) {
            const bonus = player.bonusBalls[i];
            const bonusCenterX = (bonus.gridX + 0.5) * blockWidth;
            const bonusCenterY = (bonus.gridY + 0.5) * blockHeight;

            const dist = Math.hypot(ball.x - bonusCenterX, ball.y - bonusCenterY);
            if (dist < ballRadius + 0.02) {
                player.bonusBalls.splice(i, 1);
                player.ballCount++;
            }
        }
    }
}

/**
 * AABB collision detection (relative coordinates)
 */
function ballzCheckBallBlockCollision(ball, blockCenterX, blockCenterY, blockWidth, blockHeight, ballRadius) {
    const halfWidth = blockWidth / 2;
    const halfHeight = blockHeight / 2;

    const closestX = Math.max(blockCenterX - halfWidth, Math.min(ball.x, blockCenterX + halfWidth));
    const closestY = Math.max(blockCenterY - halfHeight, Math.min(ball.y, blockCenterY + halfHeight));

    const distX = ball.x - closestX;
    const distY = ball.y - closestY;
    const distSquared = distX * distX + distY * distY;

    return distSquared < (ballRadius * ballRadius);
}

/**
 * Reflect ball off block (simplified physics)
 */
function ballzReflectBall(ball, blockCenterX, blockCenterY, blockWidth, blockHeight) {
    const dx = ball.x - blockCenterX;
    const dy = ball.y - blockCenterY;
    const halfWidth = blockWidth / 2;
    const halfHeight = blockHeight / 2;

    const overlapX = halfWidth - Math.abs(dx);
    const overlapY = halfHeight - Math.abs(dy);

    if (overlapX < overlapY) {
        ball.vx = -ball.vx;
    } else {
        ball.vy = -ball.vy;
    }
}

/**
 * Check if turn is complete (all balls returned)
 */
function ballzCheckTurnComplete(room, player) {
    const allInactive = player.balls.every(b => !b.active);
    if (allInactive && player.balls.length === player.ballCount) {
        player.turnState = 'turn_complete';
    }
}

/**
 * Advance to next turn: descend blocks, spawn new, check game over
 */
function ballzAdvanceTurn(room, player) {
    // Descend blocks
    for (const block of player.blocks) {
        block.gridY++;
    }

    // Descend bonuses
    for (const bonus of player.bonusBalls) {
        bonus.gridY++;
    }

    // Check game over (block reached bottom row)
    const bottomRow = room.rows - 1;
    for (const block of player.blocks) {
        if (block.gridY >= bottomRow) {
            player.gameOver = true;
            player.alive = false;
            room.gameOver = true;
            room.winner = {
                id: player.id,
                name: player.name,
                score: player.score,
                turnNumber: player.turnNumber
            };
            return;
        }
    }

    // Spawn new blocks
    ballzSpawnBlocks(player, room);

    // Maybe spawn bonus ball
    if (Math.random() * 100 < room.bonusBallSpawnRate) {
        ballzSpawnBonusBall(player, room);
    }

    // Reset for next turn
    player.turnNumber++;
    player.balls = [];
    player.chargeStartTime = null;
    player.chargeProgress = 0;
    player.lastTilt = null;
    player.turnState = 'aiming';
}

/**
 * Spawn bonus ball in random empty cell
 */
function ballzSpawnBonusBall(player, room) {
    const emptyCells = [];

    for (let y = 1; y < room.rows - 2; y++) {
        for (let x = 0; x < room.cols; x++) {
            const hasBlock = player.blocks.some(b => b.gridX === x && b.gridY === y);
            const hasBonus = player.bonusBalls.some(b => b.gridX === x && b.gridY === y);
            if (!hasBlock && !hasBonus) {
                emptyCells.push({ x, y });
            }
        }
    }

    if (emptyCells.length > 0) {
        const cell = emptyCells[Math.floor(Math.random() * emptyCells.length)];
        player.bonusBalls.push({
            gridX: cell.x,
            gridY: cell.y
        });
    }
}

/**
 * Simulate full trajectory with bounces for display
 * Returns array of line segments: [{x1, y1, x2, y2}, ...]
 */
function ballzSimulateTrajectory(launchX, angle, cols, rows, maxSegments = 5) {
    const segments = [];
    const ballRadius = 0.01;
    const blockWidth = 1.0 / cols;
    const blockHeight = 1.0 / rows;

    let x = launchX;
    let y = 1.0;
    let vx = Math.cos(angle) * 0.01; // Small step size for simulation
    let vy = -Math.sin(angle) * 0.01;

    let segmentCount = 0;
    let segmentStartX = x;
    let segmentStartY = y;
    const maxSteps = 1000; // Prevent infinite loops

    for (let step = 0; step < maxSteps && segmentCount < maxSegments; step++) {
        x += vx;
        y += vy;

        let bounced = false;

        // Wall bounces
        if (x <= ballRadius || x >= 1 - ballRadius) {
            vx = -vx;
            x = Math.max(ballRadius, Math.min(1 - ballRadius, x));
            bounced = true;
        }

        // Top bounce
        if (y <= ballRadius) {
            vy = -vy;
            y = ballRadius;
            bounced = true;
        }

        // Bottom return
        if (y >= 1.0) {
            segments.push({
                x1: segmentStartX,
                y1: segmentStartY,
                x2: x,
                y2: 1.0
            });
            break;
        }

        // If bounced, save segment and start new one
        if (bounced) {
            segments.push({
                x1: segmentStartX,
                y1: segmentStartY,
                x2: x,
                y2: y
            });
            segmentStartX = x;
            segmentStartY = y;
            segmentCount++;
        }
    }

    // Add final segment if not bounced
    if (segmentCount < maxSegments && y < 1.0) {
        const finalLength = 0.15; // 15% of field
        const endX = x + vx * finalLength / Math.abs(vy);
        const endY = y + vy * finalLength / Math.abs(vy);

        segments.push({
            x1: segmentStartX,
            y1: segmentStartY,
            x2: endX,
            y2: Math.max(0, endY)
        });
    }

    return segments;
}

// Start server
server.listen(PORT, () => {
    console.log(`Kinemon Games server running on http://localhost:${PORT}`);
    console.log('Room-based multiplayer enabled');
});
