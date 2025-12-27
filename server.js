/**
 * Kinemon Games - Online Multiplayer Server with Rooms
 * Manages game rooms, player connections, and collision detection
 */

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

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

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Game rooms: roomId -> room data
const rooms = new Map();

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

// Generate random room ID
function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Generate random player color
function getRandomColor() {
    const colors = ['#4CAF50', '#2196F3', '#FF9800', '#E91E63', '#9C27B0', '#00BCD4', '#FFEB3B', '#795548'];
    return colors[Math.floor(Math.random() * colors.length)];
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
        room.ball = {
            x: room.canvas.width / 2,
            y: room.canvas.height / 2,
            radius: 8,
            speedX: (settings.ballSpeed || 3) * 0.8,
            speedY: (settings.ballSpeed || 3) * 0.6
        };
        room.paddleSize = (settings.paddleSize || 2) * 50; // 50, 100, 150
        room.winScore = settings.winScore || 11;
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
    } else {
        // Snake: pizzas and calculated settings
        room.moveSpeed = BASE_MOVE_SPEED * ((settings.moveSpeed || 3) / 3); // 3 = fastest
        room.turnSpeedMultiplier = settings.turnSpeed || 2;
        room.controlMapping = settings.controlMapping || 'linear';
        room.sizeMultiplier = settings.snakeSize || 1;
        room.segmentSize = BASE_SEGMENT_SIZE * room.sizeMultiplier;
        room.pizzaSize = BASE_PIZZA_SIZE * room.sizeMultiplier;

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

                // Create room if it doesn't exist
                if (!rooms.has(roomId)) {
                    createRoom(roomId, gameType);
                }

                const room = rooms.get(roomId);

                // For Pong: limit to 2 players
                if (room.gameType === 'pong' && room.players.size >= 2) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Room is full (max 2 players for Pong)'
                    }));
                    return;
                }

                const playerId = Date.now() + '-' + Math.random();

                // Initialize player based on game type
                const player = {
                    id: playerId,
                    name: data.name || `Player ${room.players.size + 1}`,
                    color: getRandomColor(),
                    score: 0,
                    tilt: 0.5,
                    ws: ws
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
                    const axis = room.nextPlayerId % 2 === 0 ? 'X' : 'Y'; // Alternate X, Y, X, Y...
                    room.nextPlayerId++;

                    const spawnPos = spawnPlayerSquare(room, axis);

                    player.team = team;
                    player.color = getTeamColor(team);
                    player.axis = axis;
                    player.x = spawnPos.x;
                    player.y = spawnPos.y;
                    player.alive = true;
                } else {
                    // Snake: segments and position
                    player.alive = true;
                    player.segments = [];
                    player.angle = 0;
                    player.headX = room.canvas.width / 2 + (Math.random() - 0.5) * 200;
                    player.headY = room.canvas.height / 2 + (Math.random() - 0.5) * 200;
                    player.controlScheme = data.controlScheme || 'rotation_smooth';  // Store per-player control

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

                // Send initial state to new player
                ws.send(JSON.stringify({
                    type: 'init',
                    playerId: playerId,
                    roomId: roomId,
                    gameState: serializeGameState(room)
                }));

                console.log(`Player ${playerId} joined room ${roomId} as ${player.name} (${room.gameType})`);

            } else if (data.type === 'join_display') {
                const roomId = data.roomId;

                // Create room if it doesn't exist
                if (!rooms.has(roomId)) {
                    createRoom(roomId);
                }

                ws.roomId = roomId;
                ws.isDisplay = true;

                const room = rooms.get(roomId);

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
                        player.controlScheme = data.controlScheme || 'rotation_smooth';
                        console.log(`Player ${player.id} changed control to ${player.controlScheme}`);
                    }
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
                room.players.delete(ws.playerId);
                console.log(`Player ${ws.playerId} disconnected from room ${ws.roomId}`);

                // Clean up empty rooms
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
            y: p.y
        }));
        state.teamScores = room.teamScores;
        state.smiley = room.smiley;
        state.skulls = room.skulls;
        state.squareSize = room.squareSize;
        state.smileySize = room.smileySize;
        state.skullSize = room.skullSize;
        state.winScore = room.winScore;
        state.gameOver = room.gameOver;
        state.winner = room.winner ? {
            team: room.winner.team,
            score: room.winner.score
        } : null;
    } else {
        // Snake state
        state.players = Array.from(room.players.values()).map(p => ({
            id: p.id,
            name: p.name,
            color: p.color,
            score: p.score,
            alive: p.alive,
            segments: p.segments,
            angle: p.angle
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
    } else {
        updateSnake(room);
    }

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

// Update Snake game
function updateSnake(room) {
    // Update each player
    for (const player of room.players.values()) {
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

        // Remove tail segment (3x growth per pizza)
        if (player.segments.length > INITIAL_LENGTH + player.score * 3) {
            player.segments.pop();
        }
    }

    // Check collisions
    checkCollisions(room);
}

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
                room.ball.speedX = Math.abs(room.ball.speedX);

                // Add angle based on hit position
                const hitPos = (room.ball.y - player.paddleY) / room.paddleSize;
                room.ball.speedY = (hitPos - 0.5) * 10;
            }
        } else {
            // Right paddle collision
            if (room.ball.x + room.ball.radius > player.paddleX &&
                room.ball.y > player.paddleY &&
                room.ball.y < player.paddleY + room.paddleSize &&
                room.ball.speedX > 0) {
                room.ball.speedX = -Math.abs(room.ball.speedX);

                const hitPos = (room.ball.y - player.paddleY) / room.paddleSize;
                room.ball.speedY = (hitPos - 0.5) * 10;
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
    room.ball.speedX = -room.ball.speedX;
    room.ball.speedY = (Math.random() - 0.5) * 8;
}

// Update Pushers game
function updatePushers(room) {
    // Update player positions based on tilt and axis
    for (const player of room.players.values()) {
        const fieldSize = room.canvas.width; // Square field
        const margin = room.squareSize / 2;

        if (player.axis === 'X') {
            // Move only on X axis
            // tilt 0 (left) -> x = margin
            // tilt 1 (right) -> x = fieldSize - margin
            const targetX = margin + player.tilt * (fieldSize - 2 * margin);
            player.x = targetX;

            // Y position stays fixed (within bounds)
            player.y = Math.max(margin, Math.min(fieldSize - margin, player.y));
        } else {
            // Move only on Y axis
            // tilt 0 (top) -> y = margin
            // tilt 1 (bottom) -> y = fieldSize - margin
            const targetY = margin + player.tilt * (fieldSize - 2 * margin);
            player.y = targetY;

            // X position stays fixed (within bounds)
            player.x = Math.max(margin, Math.min(fieldSize - margin, player.x));
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

                // Ensure players stay within field bounds
                const margin = room.squareSize / 2;
                const fieldSize = room.canvas.width;
                p1.x = Math.max(margin, Math.min(fieldSize - margin, p1.x));
                p1.y = Math.max(margin, Math.min(fieldSize - margin, p1.y));
                p2.x = Math.max(margin, Math.min(fieldSize - margin, p2.x));
                p2.y = Math.max(margin, Math.min(fieldSize - margin, p2.y));
            }
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
                console.log(`${player.name} (${player.team}) collected smiley! Score: ${room.teamScores[player.team]}`);

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

    // Check skull collision
    for (const player of room.players.values()) {
        for (const skull of room.skulls) {
            const dx = player.x - skull.x;
            const dy = player.y - skull.y;
            const distance = Math.hypot(dx, dy);

            if (distance < (room.squareSize / 2 + room.skullSize / 2)) {
                // Player hit skull
                room.teamScores[player.team] = Math.max(0, room.teamScores[player.team] - 1);
                console.log(`${player.name} (${player.team}) hit skull! Score: ${room.teamScores[player.team]}`);

                // Respawn player at new position
                const newPos = spawnPlayerSquare(room, player.axis);
                player.x = newPos.x;
                player.y = newPos.y;
            }
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
                    console.log(`Player ${player.id} died (hit ${otherPlayer.id}) in room ${room.id}`);
                    break;
                }
            }
        }
    }
}

// Start server
server.listen(PORT, () => {
    console.log(`Kinemon Games server running on http://localhost:${PORT}`);
    console.log('Room-based multiplayer enabled');
});
