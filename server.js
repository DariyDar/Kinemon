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
const CANVAS = { width: 600, height: 800 };
const BASE_SEGMENT_SIZE = 15;
const BASE_PIZZA_SIZE = 18;
const BOUNDARY_MARGIN_BOTTOM = 40;

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
        gameLoopInterval: null
    };

    // Initialize game-specific state
    if (gameType === 'pong') {
        // Pong: ball and scores
        room.ball = {
            x: CANVAS.width / 2,
            y: CANVAS.height / 2,
            radius: 8,
            speedX: (settings.ballSpeed || 3) * 0.8,
            speedY: (settings.ballSpeed || 3) * 0.6
        };
        room.paddleSize = (settings.paddleSize || 2) * 50; // 50, 100, 150
        room.winScore = settings.winScore || 11;
    } else {
        // Snake: pizzas and calculated settings
        room.moveSpeed = BASE_MOVE_SPEED * ((settings.moveSpeed || 3) / 3); // 3 = fastest
        room.turnSpeedMultiplier = settings.turnSpeed || 2;
        room.controlMapping = settings.controlMapping || 'linear';
        room.sizeMultiplier = settings.snakeSize || 1;
        room.segmentSize = BASE_SEGMENT_SIZE * room.sizeMultiplier;
        room.pizzaSize = BASE_PIZZA_SIZE * room.sizeMultiplier;

        room.pizzas = [];
        for (let i = 0; i < 3; i++) {
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
    const maxX = CANVAS.width - margin;
    const minY = margin;
    const maxY = CANVAS.height - BOUNDARY_MARGIN_BOTTOM - margin;

    return {
        x: minX + Math.random() * (maxX - minX),
        y: minY + Math.random() * (maxY - minY),
        id: Date.now() + Math.random()
    };
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
                    player.paddleY = CANVAS.height / 2 - room.paddleSize / 2;
                    player.paddleX = isPlayer1 ? 20 : CANVAS.width - 30;
                    player.side = isPlayer1 ? 'left' : 'right';
                } else {
                    // Snake: segments and position
                    player.alive = true;
                    player.segments = [];
                    player.angle = 0;
                    player.headX = CANVAS.width / 2 + (Math.random() - 0.5) * 200;
                    player.headY = CANVAS.height / 2 + (Math.random() - 0.5) * 200;

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
                    if (player && player.alive) {
                        player.tilt = data.tilt;
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
        canvas: CANVAS
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
    }

    return state;
}

// Update game state (60 FPS per room)
function gameLoop(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.gameType === 'pong') {
        updatePong(room);
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

        // Apply control mapping curve
        let mappedDeviation = tiltDeviation;
        if (room.controlMapping === 'nonlinear_a') {
            // Moderate curve: dead zone 0.3, quadratic ramp
            const absVal = Math.abs(tiltDeviation);
            if (absVal < 0.3) {
                mappedDeviation = 0;
            } else {
                const normalized = (absVal - 0.3) / 0.7; // 0 to 1
                mappedDeviation = Math.sign(tiltDeviation) * (normalized * normalized);
            }
        } else if (room.controlMapping === 'nonlinear_b') {
            // Strong curve: dead zone 0.4, cubic ramp
            const absVal = Math.abs(tiltDeviation);
            if (absVal < 0.4) {
                mappedDeviation = 0;
            } else {
                const normalized = (absVal - 0.4) / 0.6; // 0 to 1
                mappedDeviation = Math.sign(tiltDeviation) * (normalized * normalized * normalized);
            }
        }

        const rotationSpeed = mappedDeviation * maxRotationSpeed * 2.4 * room.turnSpeedMultiplier;

        // Update angle
        player.angle += rotationSpeed;

        // Move head
        player.headX += Math.cos(player.angle) * room.moveSpeed;
        player.headY += Math.sin(player.angle) * room.moveSpeed;

        // Wrap around screen
        const minX = 0;
        const maxX = CANVAS.width;
        const minY = 0;
        const maxY = CANVAS.height - BOUNDARY_MARGIN_BOTTOM;

        if (player.headX < minX) player.headX = maxX;
        if (player.headX > maxX) player.headX = minX;
        if (player.headY < minY) player.headY = maxY;
        if (player.headY > maxY) player.headY = minY;

        // Add new head segment
        player.segments.unshift({
            x: player.headX,
            y: player.headY
        });

        // Remove tail segment
        if (player.segments.length > INITIAL_LENGTH + player.score) {
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
        const targetY = (1 - player.tilt) * (CANVAS.height - room.paddleSize);

        // Smooth movement
        player.paddleY += (targetY - player.paddleY) * 0.3;

        // Clamp position
        player.paddleY = Math.max(0, Math.min(CANVAS.height - room.paddleSize, player.paddleY));
    }

    // Update ball position
    room.ball.x += room.ball.speedX;
    room.ball.y += room.ball.speedY;

    // Top and bottom wall collision
    if (room.ball.y - room.ball.radius < 0 || room.ball.y + room.ball.radius > CANVAS.height) {
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
        }
        resetBall(room);
    } else if (room.ball.x > CANVAS.width) {
        // Left player scores
        const players = Array.from(room.players.values());
        const leftPlayer = players.find(p => p.side === 'left');
        if (leftPlayer) {
            leftPlayer.score++;
            console.log(`${leftPlayer.name} scored! Score: ${leftPlayer.score} - ${players[1]?.score || 0}`);
        }
        resetBall(room);
    }
}

// Reset ball to center (Pong)
function resetBall(room) {
    room.ball.x = CANVAS.width / 2;
    room.ball.y = CANVAS.height / 2;
    room.ball.speedX = -room.ball.speedX;
    room.ball.speedY = (Math.random() - 0.5) * 8;
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
                room.pizzas.push(spawnPizza(room));
            }
        }

        // Check self-collision
        const minSegmentsForCollision = Math.ceil((2 * Math.PI * 3 * room.segmentSize) / room.segmentSize);
        for (let i = minSegmentsForCollision; i < player.segments.length; i++) {
            const seg = player.segments[i];
            const dist = Math.hypot(head.x - seg.x, head.y - seg.y);

            if (dist < room.segmentSize * 0.8) {
                player.alive = false;
                console.log(`Player ${player.id} died (self-collision) in room ${room.id}`);
            }
        }

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
