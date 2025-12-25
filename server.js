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
const MOVE_SPEED = 1.8;
const INITIAL_LENGTH = 7;
const CANVAS = { width: 600, height: 800 };
const SEGMENT_SIZE = 15;
const PIZZA_SIZE = 18;
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
function createRoom(roomId) {
    const room = {
        id: roomId,
        players: new Map(),
        pizzas: [],
        gameLoopInterval: null
    };

    // Initialize pizzas
    for (let i = 0; i < 3; i++) {
        room.pizzas.push(spawnPizza());
    }

    rooms.set(roomId, room);
    console.log(`Room created: ${roomId}`);

    // Start game loop for this room
    room.gameLoopInterval = setInterval(() => gameLoop(roomId), 1000 / 60);

    return room;
}

// Spawn pizza
function spawnPizza() {
    const margin = PIZZA_SIZE;
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
                // Create new room
                const roomId = generateRoomId();
                createRoom(roomId);

                ws.send(JSON.stringify({
                    type: 'room_created',
                    roomId: roomId
                }));

                console.log(`Room ${roomId} created by display`);

            } else if (data.type === 'join') {
                const roomId = data.roomId;

                // Create room if it doesn't exist
                if (!rooms.has(roomId)) {
                    createRoom(roomId);
                }

                const room = rooms.get(roomId);
                const playerId = Date.now() + '-' + Math.random();

                // Initialize player
                const player = {
                    id: playerId,
                    name: data.name || `Player ${room.players.size + 1}`,
                    color: getRandomColor(),
                    score: 0,
                    alive: true,
                    segments: [],
                    angle: 0,
                    headX: CANVAS.width / 2 + (Math.random() - 0.5) * 200,
                    headY: CANVAS.height / 2 + (Math.random() - 0.5) * 200,
                    tilt: 0.5,
                    ws: ws
                };

                // Initialize snake segments
                for (let i = 0; i < INITIAL_LENGTH; i++) {
                    player.segments.push({
                        x: player.headX - i * SEGMENT_SIZE,
                        y: player.headY
                    });
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

                console.log(`Player ${playerId} joined room ${roomId} as ${player.name}`);

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
    return {
        players: Array.from(room.players.values()).map(p => ({
            id: p.id,
            name: p.name,
            color: p.color,
            score: p.score,
            alive: p.alive,
            segments: p.segments,
            angle: p.angle
        })),
        pizzas: room.pizzas,
        canvas: CANVAS
    };
}

// Update game state (60 FPS per room)
function gameLoop(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    // Update each player
    for (const player of room.players.values()) {
        if (!player.alive) continue;

        // Calculate rotation from tilt
        const circleRadius = 3 * SEGMENT_SIZE;
        const maxRotationSpeed = MOVE_SPEED / circleRadius;
        const tiltDeviation = (player.tilt - 0.5) * 2; // -1 to 1
        const rotationSpeed = tiltDeviation * maxRotationSpeed * 2.4;

        // Update angle
        player.angle += rotationSpeed;

        // Move head
        player.headX += Math.cos(player.angle) * MOVE_SPEED;
        player.headY += Math.sin(player.angle) * MOVE_SPEED;

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

// Check collisions
function checkCollisions(room) {
    for (const player of room.players.values()) {
        if (!player.alive) continue;

        const head = player.segments[0];

        // Check pizza collision
        for (let i = room.pizzas.length - 1; i >= 0; i--) {
            const pizza = room.pizzas[i];
            const dist = Math.hypot(head.x - pizza.x, head.y - pizza.y);

            if (dist < SEGMENT_SIZE / 2 + PIZZA_SIZE / 2) {
                // Ate pizza
                room.pizzas.splice(i, 1);
                player.score++;
                room.pizzas.push(spawnPizza());
            }
        }

        // Check self-collision
        const minSegmentsForCollision = Math.ceil((2 * Math.PI * 3 * SEGMENT_SIZE) / SEGMENT_SIZE);
        for (let i = minSegmentsForCollision; i < player.segments.length; i++) {
            const seg = player.segments[i];
            const dist = Math.hypot(head.x - seg.x, head.y - seg.y);

            if (dist < SEGMENT_SIZE * 0.8) {
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

                if (dist < SEGMENT_SIZE * 0.8) {
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
