/**
 * Slither Game - Pizza Snake with motion controls
 */

class SlitherGame {
    constructor(canvasId, motionController) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.motionController = motionController;

        this.isRunning = false;
        this.score = 0;

        // Constants
        this.BASE_SEGMENT_SIZE = 15;
        this.BASE_PIZZA_SIZE = 18;
        this.BASE_MOVE_SPEED = 1.8;
        this.INITIAL_LENGTH = 7; // Starting length (0 points)
        this.BOUNDARY_MARGIN_BOTTOM = 40; // Bottom boundary margin only

        // Settings multipliers (can be set from settings)
        this.turnSpeedMultiplier = 1; // 1x-5x
        this.controlMapping = 'linear'; // 'linear', 'nonlinear_a', 'nonlinear_b'
        this._moveSpeedMultiplier = 3; // 1-3 (default 3, which is current speed - fastest)
        this._sizeMultiplier = 1; // 1-5 (default 1, minimum)

        // Calculated values based on multipliers
        this.SEGMENT_SIZE = this.BASE_SEGMENT_SIZE * this._sizeMultiplier;
        this.PIZZA_SIZE = this.BASE_PIZZA_SIZE * this._sizeMultiplier;
        this.MOVE_SPEED = this.BASE_MOVE_SPEED * (this._moveSpeedMultiplier / 3); // Normalize to current speed (3 = fastest)

        // Determine which axis to use (the one with greater range during calibration)
        const calibrationData = this.motionController.getCalibrationData();
        console.log('SlitherGame calibration data:', calibrationData);
        this.useAxis = this.determineAxis(calibrationData);
        this.centerPosition = (calibrationData.min + calibrationData.max) / 2;
        this.axisRange = calibrationData.max - calibrationData.min;
        console.log('Center position:', this.centerPosition, 'Range:', this.axisRange);

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
        // Default to large (fullscreen)
        let maxWidth = window.innerWidth;
        let maxHeight = window.innerHeight;

        // Apply field size setting if exists
        if (window.gameSettings && window.gameSettings.fieldSize) {
            if (window.gameSettings.fieldSize === 'small') {
                maxWidth = 600;
                maxHeight = 800;
            } else if (window.gameSettings.fieldSize === 'medium') {
                maxWidth = window.innerWidth * 0.8;
                maxHeight = window.innerHeight * 0.8;
            }
            // 'large' uses full window dimensions (default)
        } else {
            // Fallback: use full dimensions
            maxWidth = window.innerWidth;
            maxHeight = window.innerHeight;
        }

        this.canvas.width = Math.min(window.innerWidth, maxWidth);
        this.canvas.height = Math.min(window.innerHeight, maxHeight);
    }

    /**
     * Initialize snake at center
     */
    initSnake() {
        this.snake.segments = [];
        this.snake.headX = this.canvas.width / 2;
        this.snake.headY = this.canvas.height / 2;
        this.snake.angle = 0; // Facing right (horizontal)

        // Create initial segments extending to the left from the head
        for (let i = 0; i < this.INITIAL_LENGTH; i++) {
            this.snake.segments.push({
                x: this.snake.headX - i * this.SEGMENT_SIZE,
                y: this.snake.headY
            });
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
        const margin = this.PIZZA_SIZE;
        const minX = margin;
        const maxX = this.canvas.width - margin;
        const minY = margin;
        const maxY = this.canvas.height - this.BOUNDARY_MARGIN_BOTTOM - margin;

        this.pizzas.push({
            x: minX + Math.random() * (maxX - minX),
            y: minY + Math.random() * (maxY - minY)
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

        // Map tilt to rotation with control mapping
        const circleRadius = 3 * this.SEGMENT_SIZE;
        const maxRotationSpeed = this.MOVE_SPEED / circleRadius; // radians per frame

        // Tilt 0.5 = center = no rotation
        // Tilt 0 or 1 = max rotation
        const tiltDeviation = (tilt - 0.5) * 2; // -1 to 1

        // Apply control mapping curve
        let mappedDeviation = tiltDeviation;
        if (this.controlMapping === 'nonlinear_a') {
            // Moderate curve: dead zone 0.3, quadratic ramp
            const absVal = Math.abs(tiltDeviation);
            if (absVal < 0.3) {
                mappedDeviation = 0;
            } else {
                const normalized = (absVal - 0.3) / 0.7; // 0 to 1
                mappedDeviation = Math.sign(tiltDeviation) * (normalized * normalized);
            }
        } else if (this.controlMapping === 'nonlinear_b') {
            // Strong curve: dead zone 0.4, cubic ramp
            const absVal = Math.abs(tiltDeviation);
            if (absVal < 0.4) {
                mappedDeviation = 0;
            } else {
                const normalized = (absVal - 0.4) / 0.6; // 0 to 1
                mappedDeviation = Math.sign(tiltDeviation) * (normalized * normalized * normalized);
            }
        }

        const rotationSpeed = mappedDeviation * maxRotationSpeed * 2.4 * this.turnSpeedMultiplier; // 2x base, then multiplied by settings

        // Update angle
        this.snake.angle += rotationSpeed;

        // Move head
        this.snake.headX += Math.cos(this.snake.angle) * this.MOVE_SPEED;
        this.snake.headY += Math.sin(this.snake.angle) * this.MOVE_SPEED;

        // Wrap around screen (sides wrap, bottom has boundary)
        const minX = 0;
        const maxX = this.canvas.width;
        const minY = 0;
        const maxY = this.canvas.height - this.BOUNDARY_MARGIN_BOTTOM;

        if (this.snake.headX < minX) this.snake.headX = maxX;
        if (this.snake.headX > maxX) this.snake.headX = minX;
        if (this.snake.headY < minY) this.snake.headY = maxY;
        if (this.snake.headY > maxY) this.snake.headY = minY;

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

            // Collision when circles touch: distance < head_radius + pizza_radius
            if (dist < this.SEGMENT_SIZE / 2 + this.PIZZA_SIZE / 2) {
                // Ate pizza!
                const eatenPizza = this.pizzas.splice(i, 1)[0];
                this.score++;
                this.spawnPizza();

                if (this.onScoreChange) {
                    this.onScoreChange(this.score);
                }
            }
        }

        // Check self-collision
        // Skip segments that are too close to the head (can't physically collide)
        // Need at least 2*circleRadius worth of segments to make a full circle and collide
        const minSegmentsForCollision = Math.ceil((2 * Math.PI * 3 * this.SEGMENT_SIZE) / this.SEGMENT_SIZE);

        for (let i = minSegmentsForCollision; i < this.snake.segments.length; i++) {
            const seg = this.snake.segments[i];
            const dist = Math.hypot(head.x - seg.x, head.y - seg.y);

            if (dist < this.SEGMENT_SIZE * 0.8) { // Slightly smaller for better feel
                // Hit self!
                console.log('Self collision at segment', i, 'distance', dist);
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

        // Draw bottom boundary only
        this.ctx.strokeStyle = '#FFF';
        this.ctx.lineWidth = 3;
        this.ctx.beginPath();
        this.ctx.moveTo(0, this.canvas.height - this.BOUNDARY_MARGIN_BOTTOM);
        this.ctx.lineTo(this.canvas.width, this.canvas.height - this.BOUNDARY_MARGIN_BOTTOM);
        this.ctx.stroke();

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

        // Find nearest pizza for pupil tracking
        let nearestPizza = null;
        let minDist = Infinity;
        for (const pizza of this.pizzas) {
            const dist = Math.hypot(head.x - pizza.x, head.y - pizza.y);
            if (dist < minDist) {
                minDist = dist;
                nearestPizza = pizza;
            }
        }

        // Eyes (white)
        this.ctx.fillStyle = '#FFF';
        this.ctx.beginPath();
        this.ctx.arc(4, -3, 2, 0, Math.PI * 2);
        this.ctx.arc(4, 3, 2, 0, Math.PI * 2);
        this.ctx.fill();

        // Pupils (black, tracking nearest pizza)
        if (nearestPizza) {
            // Calculate angle to nearest pizza in world coordinates
            const angleToTarget = Math.atan2(nearestPizza.y - head.y, nearestPizza.x - head.x);
            // Convert to local coordinates (relative to snake's rotation)
            const localAngle = angleToTarget - this.snake.angle;

            // Pupil offset from eye center (max 1 pixel in direction of pizza)
            const pupilOffset = 0.8;
            const pupilX = Math.cos(localAngle) * pupilOffset;
            const pupilY = Math.sin(localAngle) * pupilOffset;

            this.ctx.fillStyle = '#000';
            this.ctx.beginPath();
            this.ctx.arc(4 + pupilX, -3 + pupilY, 0.8, 0, Math.PI * 2);
            this.ctx.arc(4 + pupilX, 3 + pupilY, 0.8, 0, Math.PI * 2);
            this.ctx.fill();
        }

        this.ctx.restore();
    }

    /**
     * Get current score
     */
    getScore() {
        return { score: this.score };
    }

    /**
     * Set move speed multiplier (updates MOVE_SPEED)
     */
    set moveSpeedMultiplier(value) {
        this._moveSpeedMultiplier = value;
        this.MOVE_SPEED = this.BASE_MOVE_SPEED * (value / 3); // 3 = fastest
    }

    get moveSpeedMultiplier() {
        return this._moveSpeedMultiplier;
    }

    /**
     * Set size multiplier (updates SEGMENT_SIZE and PIZZA_SIZE)
     */
    set sizeMultiplier(value) {
        this._sizeMultiplier = value;
        this.SEGMENT_SIZE = this.BASE_SEGMENT_SIZE * value;
        this.PIZZA_SIZE = this.BASE_PIZZA_SIZE * value;
    }

    get sizeMultiplier() {
        return this._sizeMultiplier;
    }
}
