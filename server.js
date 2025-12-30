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

        room.ship = {
            x: room.canvas.width / 2,
            y: room.canvas.height / 2,
            radius: 30, // Increased from 15 to 30 (2x larger)
            vx: 0,
            vy: 0,
            rotation: 0,
            hearts: 10,
            coins: 0,
            lastDamageTime: 0,
            invulnerable: false,
            invulnerableUntil: 0
        };

        room.systems = {
            engine: {
                amplitude: 0,
                energy: 0         // Accumulated energy from pumps
            },
            rudder: {
                rotation: 0,
                autoRotateSpeed: 0.5
            },
            weapon: {
                energy: 0,                    // Накопленная энергия зарядки (0-10)
                lastWeaponTilt: undefined,    // Для detectWeaponPump()
                isCharging: false             // Флаг активной зарядки
            },
            weaponDirection: {
                rotation: 0,
                autoRotateSpeed: 0.7
            },
            shield: {
                rotation: 0,
                arcSize: 72,
                active: false
            }
        };

        room.bullets = [];
        room.asteroids = [];
        room.lastAsteroidSpawn = Date.now();
        room.coins = [];
        room.hearts = [];

        // Settings
        room.thrustSystem = settings.thrustSystem || 'pump'; // 'pump' or 'gradient'
        room.engineFormula = settings.engineFormula || 'balanced';
        room.weaponFormula = settings.weaponFormula || 'standard';
        room.coinsToWin = settings.coinsToWin || 10;
        room.asteroidFrequency = settings.asteroidFrequency || 'medium';

        // Initialize coins - only 1 coin at a time
        room.coins.push(spawnCoin(room));

        room.gameStarted = false; // Ship starts after all players ready (lobby system)
        room.lobbyCountdown = null; // Countdown timer
        room.lobbyCountdownStart = null; // Countdown start time
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
        console.log(`🚀 Pump! Tilt: ${lastTilt.toFixed(2)} -> ${currentTilt.toFixed(2)} (Δ${delta.toFixed(3)}), Energy: +${energyBoost.toFixed(2)}`);
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

// Calculate energy from tilt angle (gradient system)
// Returns energy gained from upward phone movement based on degree ranges
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

    // Energy decays slowly, providing sustained thrust
    const normalizedEnergy = Math.min(energy / 10, 1); // 0-1
    const thrustMult = (room.physics && room.physics.thrustMult) || 0.8;

    switch (formula) {
        case 'balanced':
            return thrustMult * normalizedEnergy;
        case 'speed':
            return (thrustMult * 1.25) * normalizedEnergy;
        case 'combo':
            return (thrustMult * 0.75) * normalizedEnergy;
        default:
            return thrustMult * normalizedEnergy;
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

        console.log(`Thrust applied: ${thrust.toFixed(3)}, Energy: ${room.systems.engine.energy.toFixed(2)}, Speed: ${Math.hypot(room.ship.vx, room.ship.vy).toFixed(2)}`);

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
        const energyDecay = (room.physics && room.physics.energyDecay) || 0.05;
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
        1:  { size: 2,  speed: 5,  distance: 100, bulletCount: 1 },
        2:  { size: 4,  speed: 6,  distance: 200, bulletCount: 1 },
        3:  { size: 6,  speed: 8,  distance: 300, bulletCount: 1 },
        4:  { size: 8,  speed: 10, distance: 400, bulletCount: 2 },
        5:  { size: 9,  speed: 10, distance: 500, bulletCount: 2 },
        6:  { size: 9,  speed: 12, distance: 600, bulletCount: 2 },
        7:  { size: 10, speed: 12, distance: 650, bulletCount: 3 },
        8:  { size: 11, speed: 12, distance: 700, bulletCount: 3 },
        9:  { size: 12, speed: 14, distance: 720, bulletCount: 3 },
        10: { size: 12, speed: 17, distance: 800, bulletCount: 5 }
    };

    const stats = balanceTable[powerLevel];
    const size = stats.size;
    const speed = stats.speed;
    const distance = stats.distance;
    const bulletCount = stats.bulletCount;

    // DAMAGE: always 1x for all levels (as per table)
    const damage = 1;

    console.log(`🎯 Bullet: Lv${powerLevel}, Count:${bulletCount}, Size:${size}px, Speed:${speed}, Dist:${distance}`);

    return { powerLevel, size, speed, distance, damage, bulletCount };
}

// Fire bullets from weapon using accumulated energy
function fireBullet(room) {
    const weapon = room.systems.weapon;

    // Don't fire if no energy (минимум 0.1)
    if (weapon.energy < 0.1) return;

    // Calculate bullet parameters from energy (includes bulletCount)
    const params = calculateBulletParams(weapon.energy);

    const angle = room.systems.weaponDirection.rotation * Math.PI / 180;
    const weaponPos = getSystemPosition(room.ship, room.systems.weaponDirection.rotation);

    // Fire multiple bullets with slight spread
    for (let i = 0; i < params.bulletCount; i++) {
        // Small random spread for multiple bullets
        const spread = params.bulletCount > 1 ? (Math.random() - 0.5) * 0.2 : 0;
        const bulletAngle = angle + spread;

        room.bullets.push({
            x: weaponPos.x,
            y: weaponPos.y,
            vx: Math.cos(bulletAngle) * params.speed,
            vy: Math.sin(bulletAngle) * params.speed,
            damage: params.damage,
            size: params.size,              // Для отрисовки
            powerLevel: params.powerLevel,  // Для цвета (1-9 cyan, 10 red)
            distanceTraveled: 0,
            maxDistance: params.distance,
            id: Date.now() + Math.random() + i
        });
    }

    // Visual effects
    const effectColor = (params.powerLevel === 10) ? '#FF0000' : '#00FFFF';
    const effectCount = Math.ceil(params.bulletCount / 2);

    broadcastEffect(room.id, 'particle', {
        x: weaponPos.x,
        y: weaponPos.y,
        color: effectColor,
        count: effectCount
    });
    broadcastEffect(room.id, 'shake', { intensity: params.powerLevel / 5 });

    // Reset energy after firing
    weapon.energy = 0;
    weapon.isCharging = false;
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
    // 3% chance to drop heart (small asteroids only)
    if (asteroid.size === 'small' && Math.random() < 0.03) {
        room.hearts.push({ x: asteroid.x, y: asteroid.y, id: Date.now() + Math.random() });
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
    const ship = room.ship;

    // Bullet-Asteroid collisions
    for (let i = room.bullets.length - 1; i >= 0; i--) {
        const bullet = room.bullets[i];

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

    // Ship-Asteroid collisions
    for (let i = room.asteroids.length - 1; i >= 0; i--) {
        const asteroid = room.asteroids[i];
        const dist = Math.hypot(asteroid.x - ship.x, asteroid.y - ship.y);

        if (dist < ship.radius + asteroid.radius) {
            const angleToAsteroid = Math.atan2(asteroid.y - ship.y, asteroid.x - ship.x) * 180 / Math.PI;

            // Check if shield blocks
            if (room.systems.shield.active && isAngleInShieldArc(angleToAsteroid, room.systems.shield.rotation, 72)) {
                deflectAsteroid(asteroid, ship, room.systems.shield.rotation, room);
            } else {
                // Impulse-based damage
                const relativeSpeed = Math.hypot(asteroid.vx - ship.vx, asteroid.vy - ship.vy);
                const sizeMultiplier = { large: 1.5, medium: 1.0, small: 0.5 }[asteroid.size];
                const impulseDamage = Math.ceil(relativeSpeed * sizeMultiplier * 0.3);
                const damage = Math.max(1, impulseDamage);

                if (!ship.invulnerable) {
                    ship.hearts = Math.max(0, ship.hearts - damage);
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

                    if (ship.hearts <= 0) {
                        room.gameOver = true;
                        room.winner = null;
                    }
                }
            }
        }
    }

    // Ship-Coin collisions
    for (let i = room.coins.length - 1; i >= 0; i--) {
        const coin = room.coins[i];
        const dist = Math.hypot(coin.x - ship.x, coin.y - ship.y);

        if (dist < ship.radius + 10) {
            ship.coins++;
            room.coins.splice(i, 1);
            room.coins.push(spawnCoin(room));

            broadcastEffect(room.id, 'particle', { x: coin.x, y: coin.y, color: '#FFD700', count: 10 });
            broadcastEffect(room.id, 'scoreAnim', { x: ship.x, y: ship.y - ship.radius - 20, text: '+1', color: '#FFD700' });

            if (ship.coins >= room.coinsToWin) {
                room.winner = { team: 'Ship Crew', score: ship.coins };
                room.gameOver = true;
            }
        }
    }

    // Ship-Heart collisions
    for (let i = room.hearts.length - 1; i >= 0; i--) {
        const heart = room.hearts[i];
        const dist = Math.hypot(heart.x - ship.x, heart.y - ship.y);

        if (dist < ship.radius + 12) {
            if (ship.hearts < 10) {
                ship.hearts = Math.min(10, ship.hearts + 1);
                room.hearts.splice(i, 1);

                broadcastEffect(room.id, 'particle', { x: heart.x, y: heart.y, color: '#FF1744', count: 15 });
                broadcastEffect(room.id, 'flash', { color: '#FF1744', intensity: 0.2 });
            }
        }
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

    // Send startTime to Display only
    room.players.forEach((player) => {
        // Check if this is a display connection (doesn't have playerId before init)
        // For now, send to all - display will show countdown, controllers won't
        if (player.ws && player.ws.readyState === 1) { // OPEN
            player.ws.send(JSON.stringify({
                type: 'lobby_countdown',
                startTime: startTime,
                duration: COUNTDOWN_DURATION
            }));
        }
    });

    // Timer for server-side countdown completion
    room.lobbyCountdown = setTimeout(() => {
        room.lobbyCountdown = null;
        room.lobbyCountdownStart = null;
        room.gameStarted = true;
        console.log(`[LOBBY] Game started in room ${room.id}`);

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

    // Notify all clients
    room.players.forEach((player) => {
        if (player.ws && player.ws.readyState === 1) {
            player.ws.send(JSON.stringify({
                type: 'lobby_countdown_cancelled'
            }));
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

                console.log(`[JOIN] Received join request: room=${roomId}, gameType=${gameType}, player=${data.name}`);

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
                    // Ship: player starts as observer (no role assigned)
                    player.systemRole = null;
                    player.systemIndex = null;
                    player.lastTilt = undefined;  // Previous tilt value (undefined allows proper first pump detection)
                    player.alive = true;          // All players share ship health
                    player.ready = false;         // Player hasn't pressed "Ready" button yet

                    console.log(`Player ${player.name} joined as observer (no role assigned)`);
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
                const initMessage = {
                    type: 'init',
                    playerId: playerId,
                    roomId: roomId,
                    gameState: serializeGameState(room),
                    gameStarted: room.gameStarted // Include gameStarted flag for reconnect handling
                };
                console.log(`[JOIN] Sending init message to ${player.name}:`, JSON.stringify(initMessage).substring(0, 100) + '...');
                ws.send(JSON.stringify(initMessage));

                console.log(`[JOIN] Player ${playerId} joined room ${roomId} as ${player.name} (${room.gameType})`);

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

                    // If player wants to release role
                    if (requestedRole === null) {
                        player.systemRole = null;
                        player.systemIndex = null;
                        console.log(`Player ${player.name} released their role`);
                        broadcastGameState(room);
                        return;
                    }

                    // Check if role is already taken
                    const roleTaken = Array.from(room.players.values()).some(p =>
                        p.id !== player.id && p.systemRole === requestedRole
                    );

                    if (roleTaken) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Эта роль уже занята другим игроком'
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

                    // For Ship game: handle lobby countdown cancellation
                    if (room.gameType === 'ship') {
                        // If player was ready in lobby, cancel countdown
                        if (!room.gameStarted && player.ready) {
                            console.log(`[LOBBY] Player ${player.name} was ready - cancelling countdown`);
                            cancelLobbyCountdown(room);
                        }

                        // Log role being freed (goes to autopilot)
                        if (player.systemRole) {
                            console.log(`[DISCONNECT] Role ${player.systemRole} freed (autopilot)`);
                        }
                    }
                }

                room.players.delete(ws.playerId);
                broadcastGameState(room);

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
        // Ship state
        state.ship = {
            x: room.ship.x,
            y: room.ship.y,
            radius: room.ship.radius,
            vx: room.ship.vx,
            vy: room.ship.vy,
            rotation: room.ship.rotation,
            hearts: room.ship.hearts,
            coins: room.ship.coins,
            lastDamageTime: room.ship.lastDamageTime,
            invulnerable: room.ship.invulnerable
        };

        state.systems = room.systems;

        state.bullets = room.bullets.map(b => ({ x: b.x, y: b.y, id: b.id }));

        state.asteroids = room.asteroids.map(a => ({
            x: a.x, y: a.y, size: a.size, radius: a.radius,
            health: a.health, maxHealth: a.maxHealth,
            rotation: a.rotation, flashUntil: a.flashUntil, id: a.id
        }));

        state.coins = room.coins;
        state.hearts = room.hearts;

        state.players = Array.from(room.players.values()).map(p => ({
            id: p.id, name: p.name, color: p.color,
            systemRole: p.systemRole, systemIndex: p.systemIndex, alive: p.alive,
            ready: p.ready
        }));

        state.thrustSystem = room.thrustSystem;
        state.engineFormula = room.engineFormula;
        state.weaponFormula = room.weaponFormula;
        state.coinsToWin = room.coinsToWin;
        state.asteroidFrequency = room.asteroidFrequency;

        // Send energy level for gradient system visualization
        state.energyLevel = room.thrustSystem === 'gradient' ? getEnergyLevel(room.systems.engine.energy) : 0;

        // Send weapon state for charging cone visualization
        state.weaponEnergy = room.systems.weapon.energy;        // 0-10 для визуализации
        state.weaponCharging = room.systems.weapon.isCharging; // true/false для конуса

        state.gameStarted = room.gameStarted;
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
    } else if (room.gameType === 'ship') {
        updateShip(room);
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
                // Accelerate ball by 5% on each paddle hit
                const accelerated = Math.abs(room.ball.speedX) * 1.05;
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
                // Accelerate ball by 5% on each paddle hit
                const accelerated = Math.abs(room.ball.speedX) * 1.05;
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
    // Reset hasPlayer flags for all systems
    room.systems.engine.hasPlayer = false;
    room.systems.weapon.hasPlayer = false;

    // 1. Update system states from players
    for (const player of room.players.values()) {
        if (!player.systemRole) continue;

        const tilt = player.tilt;

        switch (player.systemRole) {
            case 'engine':
                // Energy accumulation depends on thrust system
                let energyAdded;
                if (room.thrustSystem === 'gradient') {
                    // Gradient system: progressive energy from degree-based tilt
                    energyAdded = calculateGradientEnergy(tilt, player.lastTilt);
                    room.systems.engine.energy = Math.min(room.systems.engine.energy + energyAdded, 750); // Cap at 750 (5 levels × 150)
                    player.lastTilt = tilt; // Update for next frame
                } else {
                    // Pump system: delta-based upward jerks
                    energyAdded = detectPump(player, tilt, room);
                    room.systems.engine.energy = Math.min(room.systems.engine.energy + energyAdded, 10); // Cap at 10
                }
                room.systems.engine.hasPlayer = true;
                break;
            case 'rudder':
                room.systems.rudder.rotation = tilt * 360;
                break;
            case 'weapon':
                // Position-based weapon charging system
                const weaponResult = updateWeaponCharge(player, tilt, room);

                // Fire on downward movement (BEFORE updating energy)
                if (weaponResult.shouldFire && weaponResult.bulletCount > 0) {
                    fireBullet(room);
                    // Energy reset to 0 in fireBullet, don't update it
                } else {
                    // Only update energy if not firing
                    room.systems.weapon.energy = weaponResult.newEnergy;
                }

                room.systems.weapon.hasPlayer = true;
                break;
            case 'weaponDirection':
                room.systems.weaponDirection.rotation = tilt * 360;
                break;
            case 'shield':
                room.systems.shield.rotation = tilt * 360;
                room.systems.shield.active = true;
                break;
        }
    }

    // 2. Auto-rotate unoccupied systems
    const occupied = new Set(Array.from(room.players.values()).map(p => p.systemRole).filter(r => r !== null));

    if (!occupied.has('rudder')) {
        room.systems.rudder.rotation = (room.systems.rudder.rotation + 0.5) % 360;
    }
    if (!occupied.has('weaponDirection')) {
        room.systems.weaponDirection.rotation = (room.systems.weaponDirection.rotation - 0.7 + 360) % 360; // Opposite direction, normalized
    }
    if (!occupied.has('weapon')) {
        // Auto-pilot: periodic auto-fire with medium power
        if (!room.lastAutoWeaponFire) room.lastAutoWeaponFire = Date.now();
        const timeSinceLastFire = Date.now() - room.lastAutoWeaponFire;

        // Fire every 1500ms
        if (timeSinceLastFire > 1500) {
            // Energy 3.5 → Level 4 → distance ~500px (-44% от макс)
            room.systems.weapon.energy = 3.5;
            fireBullet(room);
            room.lastAutoWeaponFire = Date.now();
        }

        room.systems.weapon.hasPlayer = true;
    }
    if (!occupied.has('engine')) {
        // Auto-pilot: simulate pump motions by adding periodic energy pulses
        if (!room.lastAutoPump) room.lastAutoPump = Date.now();
        const timeSinceLastPump = Date.now() - room.lastAutoPump;

        // Pump every 600ms to demonstrate pump mechanics
        if (timeSinceLastPump > 600) {
            room.systems.engine.energy = Math.min(room.systems.engine.energy + 7, 10); // Add pump energy (increased to 7)
            room.lastAutoPump = Date.now();
        }

        room.systems.engine.hasPlayer = true; // Enable auto-thrust
    }
    // Shield always active, rotates slowly when no player
    if (!occupied.has('shield')) {
        room.systems.shield.active = true; // Always on
        room.systems.shield.rotation = (room.systems.shield.rotation + 0.3) % 360; // Slow rotation
    } else {
        room.systems.shield.active = true;
    }

    // 3. Apply engine thrust
    applyEngineThrust(room);

    // 4. Update ship position
    updateShipPosition(room);

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

    // 7. Spawn asteroids
    spawnAsteroidIfNeeded(room);

    // 8. Update asteroids
    for (const asteroid of room.asteroids) {
        asteroid.x += asteroid.vx;
        asteroid.y += asteroid.vy;
        asteroid.rotation += asteroid.rotationSpeed;
    }

    // 9. Collision detection
    checkShipCollisions(room);

    // 10. Clear invulnerability
    if (room.ship.invulnerable && Date.now() >= room.ship.invulnerableUntil) {
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
