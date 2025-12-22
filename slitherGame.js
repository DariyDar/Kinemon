/**
 * Slither Game - Pizza Snake with motion controls
 */

class SlitherGame {
    constructor(canvasId, motionController) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.motionController = motionController;

        this.isRunning = false;
        this.isCentering = false;
        this.score = 0;

        // Constants
        this.SEGMENT_SIZE = 15;
        this.PIZZA_SIZE = 18;
        this.INITIAL_LENGTH = 3;
        this.MOVE_SPEED = 2.5;

        // Determine which axis to use (the one with greater range during calibration)
        const calibrationData = this.motionController.getCalibrationData();
        this.useAxis = this.determineAxis(calibrationData);
        this.centerPosition = (calibrationData.min + calibrationData.max) / 2;
        this.axisRange = calibrationData.max - calibrationData.min;

        // Snake state
        this.snake = {
            segments: [],
            angle: 0, // Direction in radians
            headX: 0,
            headY: 0
        };

        // Pizzas
        this.pizzas = [];
        this.pizzaCount = 1;

        // Centering
        this.centeringCallback = null;
        this.centeringTime = 0;
        this.centeringCanvas = document.getElementById('centeringCanvas');
        this.centeringCtx = this.centeringCanvas ? this.centeringCanvas.getContext('2d') : null;

        // Callbacks
        this.onScoreChange = null;
        this.onDeath = null;

        this.resizeCanvas();
        this.initSnake();
    }

    /**
     * Determine which axis has greater range
     */
    determineAxis(calibrationData) {
        // This is a simplified version - in real implementation,
        // we'd track both beta and gamma changes during calibration
        // For now, we assume beta (tilt forward/back) is primary
        return 'beta';
    }

    /**
     * Resize canvas to fit screen
     */
    resizeCanvas() {
        this.canvas.width = Math.min(window.innerWidth, 600);
        this.canvas.height = Math.min(window.innerHeight, 800);
    }

    /**
     * Initialize snake at center
     */
    initSnake() {
        this.snake.segments = [];
        this.snake.headX = this.canvas.width / 2;
        this.snake.headY = this.canvas.height / 2;
        this.snake.angle = 0; // Facing right

        // Create initial segments
        for (let i = 0; i < this.INITIAL_LENGTH; i++) {
            this.snake.segments.push({
                x: this.snake.headX - i * this.SEGMENT_SIZE,
                y: this.snake.headY
            });
        }
    }

    /**
     * Start centering process
     */
    startCentering(callback) {
        this.isCentering = true;
        this.centeringCallback = callback;
        this.centeringTime = 0;
        this.initSnake();
        this.centeringLoop();
    }

    /**
     * Centering animation loop
     */
    centeringLoop() {
        if (!this.isCentering) return;

        // Get current tilt
        const currentTilt = this.motionController.getRawTilt();
        const deviation = Math.abs(currentTilt - this.centerPosition);
        const deviationPercent = deviation / this.axisRange;

        // Check if within 5% of center
        const isCentered = deviationPercent <= 0.05;

        // Draw centering visualization
        this.drawCenteringScreen(isCentered, Math.ceil(3 - this.centeringTime));

        if (isCentered) {
            this.centeringTime += 1/60; // Assuming 60 FPS

            if (this.centeringTime >= 3) {
                // Centering complete!
                this.isCentering = false;
                if (this.centeringCallback) {
                    this.centeringCallback(0);
                }
                return;
            } else {
                // Still centering, show countdown
                if (this.centeringCallback) {
                    this.centeringCallback(Math.ceil(3 - this.centeringTime));
                }
            }
        } else {
            // Reset timer if not centered
            this.centeringTime = 0;
            if (this.centeringCallback) {
                this.centeringCallback(-1);
            }
        }

        requestAnimationFrame(() => this.centeringLoop());
    }

    /**
     * Draw centering screen visualization
     */
    drawCenteringScreen(isCentered, countdown) {
        if (!this.centeringCtx) return;

        const ctx = this.centeringCtx;
        const canvas = this.centeringCanvas;
        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;

        // Clear
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Draw field
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 2;
        ctx.strokeRect(50, 50, 300, 300);

        // Draw snake
        const snakeColor = isCentered ? '#4CAF50' : '#F44336';

        // Body segments
        ctx.fillStyle = snakeColor;
        for (let i = 1; i < this.snake.segments.length; i++) {
            const seg = this.snake.segments[i];
            const drawX = 50 + (seg.x / this.canvas.width) * 300;
            const drawY = 50 + (seg.y / this.canvas.height) * 300;
            ctx.beginPath();
            ctx.arc(drawX, drawY, this.SEGMENT_SIZE / 2, 0, Math.PI * 2);
            ctx.fill();
        }

        // Head with rotation based on current tilt
        const currentTilt = this.motionController.getNormalizedTilt();
        const headAngle = (currentTilt - 0.5) * Math.PI; // -90° to +90°

        const head = this.snake.segments[0];
        const drawX = 50 + (head.x / this.canvas.width) * 300;
        const drawY = 50 + (head.y / this.canvas.height) * 300;

        ctx.save();
        ctx.translate(drawX, drawY);
        ctx.rotate(headAngle);

        // Head circle
        ctx.fillStyle = snakeColor;
        ctx.beginPath();
        ctx.arc(0, 0, this.SEGMENT_SIZE / 2, 0, Math.PI * 2);
        ctx.fill();

        // Eyes
        ctx.fillStyle = '#FFF';
        ctx.beginPath();
        ctx.arc(3, -3, 2, 0, Math.PI * 2);
        ctx.arc(3, 3, 2, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();

        // Countdown
        if (isCentered && countdown > 0) {
            ctx.fillStyle = '#4CAF50';
            ctx.font = 'bold 72px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(countdown, centerX, centerY + 120);
        }
    }

    /**
     * Start the game
     */
    start() {
        this.isRunning = true;
        this.score = 0;
        this.initSnake();
        this.spawnPizzas();
        this.gameLoop();
    }

    /**
     * Stop the game
     */
    stop() {
        this.isRunning = false;
        this.isCentering = false;
    }

    /**
     * Spawn pizzas on the field
     */
    spawnPizzas() {
        this.pizzas = [];
        for (let i = 0; i < this.pizzaCount; i++) {
            this.spawnPizza();
        }
    }

    /**
     * Spawn a single pizza
     */
    spawnPizza() {
        const margin = this.PIZZA_SIZE * 2;
        this.pizzas.push({
            x: margin + Math.random() * (this.canvas.width - margin * 2),
            y: margin + Math.random() * (this.canvas.height - margin * 2)
        });
    }

    /**
     * Main game loop
     */
    gameLoop() {
        if (!this.isRunning) return;

        this.update();
        this.draw();

        requestAnimationFrame(() => this.gameLoop());
    }

    /**
     * Update game state
     */
    update() {
        this.updateSnake();
        this.checkCollisions();
    }

    /**
     * Update snake movement
     */
    updateSnake() {
        // Get tilt and convert to rotation speed
        const tilt = this.motionController.getNormalizedTilt();

        // Map tilt to rotation
        // At edges (0 or 1), snake should make a circle with radius = 3 segments
        // Circle circumference = 2πr = 2π * 3 * SEGMENT_SIZE
        // At max speed, complete circle with 6-segment snake
        const circleRadius = 3 * this.SEGMENT_SIZE;
        const maxRotationSpeed = this.MOVE_SPEED / circleRadius; // radians per frame

        // Tilt 0.5 = center = no rotation
        // Tilt 0 or 1 = max rotation
        const tiltDeviation = (tilt - 0.5) * 2; // -1 to 1
        const rotationSpeed = tiltDeviation * maxRotationSpeed;

        // Update angle
        this.snake.angle += rotationSpeed;

        // Move head
        this.snake.headX += Math.cos(this.snake.angle) * this.MOVE_SPEED;
        this.snake.headY += Math.sin(this.snake.angle) * this.MOVE_SPEED;

        // Wrap around screen
        if (this.snake.headX < 0) this.snake.headX = this.canvas.width;
        if (this.snake.headX > this.canvas.width) this.snake.headX = 0;
        if (this.snake.headY < 0) this.snake.headY = this.canvas.height;
        if (this.snake.headY > this.canvas.height) this.snake.headY = 0;

        // Add new head segment
        this.snake.segments.unshift({
            x: this.snake.headX,
            y: this.snake.headY
        });

        // Remove tail segment (unless we just ate)
        if (this.snake.segments.length > this.INITIAL_LENGTH + this.score) {
            this.snake.segments.pop();
        }
    }

    /**
     * Check collisions
     */
    checkCollisions() {
        const head = this.snake.segments[0];

        // Check pizza collision
        for (let i = this.pizzas.length - 1; i >= 0; i--) {
            const pizza = this.pizzas[i];
            const dist = Math.hypot(head.x - pizza.x, head.y - pizza.y);

            if (dist < this.SEGMENT_SIZE + this.PIZZA_SIZE / 2) {
                // Ate pizza!
                this.pizzas.splice(i, 1);
                this.score++;
                this.spawnPizza();

                if (this.onScoreChange) {
                    this.onScoreChange(this.score);
                }
            }
        }

        // Check self-collision (skip first few segments)
        for (let i = 4; i < this.snake.segments.length; i++) {
            const seg = this.snake.segments[i];
            const dist = Math.hypot(head.x - seg.x, head.y - seg.y);

            if (dist < this.SEGMENT_SIZE) {
                // Hit self!
                this.die();
                return;
            }
        }
    }

    /**
     * Handle death
     */
    die() {
        this.isRunning = false;
        if (this.onDeath) {
            this.onDeath(this.score);
        }
    }

    /**
     * Draw game
     */
    draw() {
        // Clear
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        // Draw pizzas
        this.drawPizzas();

        // Draw snake
        this.drawSnake();
    }

    /**
     * Draw pizzas
     */
    drawPizzas() {
        for (const pizza of this.pizzas) {
            // Pizza base (red circle)
            this.ctx.fillStyle = '#D32F2F';
            this.ctx.beginPath();
            this.ctx.arc(pizza.x, pizza.y, this.PIZZA_SIZE / 2, 0, Math.PI * 2);
            this.ctx.fill();

            // Cheese triangles (yellow)
            this.ctx.fillStyle = '#FDD835';
            for (let i = 0; i < 6; i++) {
                const angle = (i / 6) * Math.PI * 2;
                const x1 = pizza.x + Math.cos(angle) * this.PIZZA_SIZE / 3;
                const y1 = pizza.y + Math.sin(angle) * this.PIZZA_SIZE / 3;
                const x2 = pizza.x + Math.cos(angle + Math.PI / 6) * this.PIZZA_SIZE / 2.5;
                const y2 = pizza.y + Math.sin(angle + Math.PI / 6) * this.PIZZA_SIZE / 2.5;

                this.ctx.beginPath();
                this.ctx.moveTo(pizza.x, pizza.y);
                this.ctx.lineTo(x1, y1);
                this.ctx.lineTo(x2, y2);
                this.ctx.closePath();
                this.ctx.fill();
            }
        }
    }

    /**
     * Draw snake
     */
    drawSnake() {
        // Draw body segments
        this.ctx.fillStyle = '#4CAF50';
        for (let i = 1; i < this.snake.segments.length; i++) {
            const seg = this.snake.segments[i];
            this.ctx.beginPath();
            this.ctx.arc(seg.x, seg.y, this.SEGMENT_SIZE / 2, 0, Math.PI * 2);
            this.ctx.fill();
        }

        // Draw head with eyes
        const head = this.snake.segments[0];

        this.ctx.save();
        this.ctx.translate(head.x, head.y);
        this.ctx.rotate(this.snake.angle);

        // Head circle
        this.ctx.fillStyle = '#66BB6A';
        this.ctx.beginPath();
        this.ctx.arc(0, 0, this.SEGMENT_SIZE / 2, 0, Math.PI * 2);
        this.ctx.fill();

        // Eyes
        this.ctx.fillStyle = '#FFF';
        this.ctx.beginPath();
        this.ctx.arc(4, -3, 2, 0, Math.PI * 2);
        this.ctx.arc(4, 3, 2, 0, Math.PI * 2);
        this.ctx.fill();

        this.ctx.restore();
    }

    /**
     * Get current score
     */
    getScore() {
        return { score: this.score };
    }
}
