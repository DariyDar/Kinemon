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
        this.BASE_SEGMENT_SIZE = 15;
        this.BASE_PIZZA_SIZE = 18;
        this.BASE_MOVE_SPEED = 1.8;
        this.INITIAL_LENGTH = 7; // Starting length (0 points)
        this.BOUNDARY_MARGIN = 30; // Visible boundary margin

        // Settings multipliers (can be set from settings)
        this.turnSpeedMultiplier = 1; // 1x-5x
        this._moveSpeedMultiplier = 4; // 1-5 (default 4, which is current speed)
        this._sizeMultiplier = 1; // 1-5 (default 1, minimum)

        // Calculated values based on multipliers
        this.SEGMENT_SIZE = this.BASE_SEGMENT_SIZE * this._sizeMultiplier;
        this.PIZZA_SIZE = this.BASE_PIZZA_SIZE * this._sizeMultiplier;
        this.MOVE_SPEED = this.BASE_MOVE_SPEED * (this._moveSpeedMultiplier / 4); // Normalize to current speed

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

        // Swallowing animation
        this.swallowingPizzas = []; // Array of {segmentIndex: number, progress: 0-1}

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

        // Debug logging
        if (Math.random() < 0.1) { // Log 10% of frames to avoid spam
            console.log('Centering:', {
                currentTilt,
                centerPosition: this.centerPosition,
                deviation,
                deviationPercent,
                axisRange: this.axisRange
            });
        }

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

        // Snake color based on alignment
        const snakeColor = isCentered ? '#4CAF50' : '#F44336';
        const snakeBodyColor = isCentered ? '#4CAF50' : '#F44336';

        // Draw 7-segment snake in a horizontal line
        // Head at exact center, body extending to the left
        const segmentSpacing = this.SEGMENT_SIZE;

        // Get current tilt to show rotation
        const currentTilt = this.motionController.getNormalizedTilt();
        const headAngle = (currentTilt - 0.5) * Math.PI; // -90° to +90°

        // Draw body segments (segments 1-6, from left to right)
        ctx.fillStyle = snakeBodyColor;
        for (let i = 6; i >= 1; i--) {
            const segX = centerX - i * segmentSpacing;
            const segY = centerY;
            ctx.beginPath();
            ctx.arc(segX, segY, this.SEGMENT_SIZE / 2, 0, Math.PI * 2);
            ctx.fill();
        }

        // Draw head (segment 0) at exact center with rotation
        ctx.save();
        ctx.translate(centerX, centerY);
        ctx.rotate(headAngle);

        // Head circle
        ctx.fillStyle = isCentered ? '#66BB6A' : '#EF5350';
        ctx.beginPath();
        ctx.arc(0, 0, this.SEGMENT_SIZE / 2, 0, Math.PI * 2);
        ctx.fill();

        // Eyes
        ctx.fillStyle = '#FFF';
        ctx.beginPath();
        ctx.arc(4, -3, 2, 0, Math.PI * 2);
        ctx.arc(4, 3, 2, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();

        // Countdown
        if (isCentered && countdown > 0) {
            ctx.fillStyle = '#4CAF50';
            ctx.font = 'bold 72px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(countdown, centerX, centerY + 80);
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
        const margin = this.BOUNDARY_MARGIN + this.PIZZA_SIZE;
        const minX = margin;
        const maxX = this.canvas.width - margin;
        const minY = margin;
        const maxY = this.canvas.height - margin;

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
        this.updateSwallowingAnimation();
        this.checkCollisions();
    }

    /**
     * Update swallowing animation
     */
    updateSwallowingAnimation() {
        for (let i = this.swallowingPizzas.length - 1; i >= 0; i--) {
            const swallow = this.swallowingPizzas[i];

            // Progress the animation (move down the snake)
            swallow.progress += 0.15; // Speed of bulge traveling

            // When progress >= 1, move to next segment
            if (swallow.progress >= 1) {
                swallow.progress = 0;
                swallow.segmentIndex++;

                // If reached the tail, remove from animation
                if (swallow.segmentIndex >= this.snake.segments.length) {
                    this.swallowingPizzas.splice(i, 1);
                }
            }
        }
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
        const rotationSpeed = tiltDeviation * maxRotationSpeed * 2.4 * this.turnSpeedMultiplier; // 2x base (was 1.2), then multiplied by settings

        // Update angle
        this.snake.angle += rotationSpeed;

        // Move head
        this.snake.headX += Math.cos(this.snake.angle) * this.MOVE_SPEED;
        this.snake.headY += Math.sin(this.snake.angle) * this.MOVE_SPEED;

        // Wrap around screen with boundaries
        const minX = this.BOUNDARY_MARGIN;
        const maxX = this.canvas.width - this.BOUNDARY_MARGIN;
        const minY = this.BOUNDARY_MARGIN;
        const maxY = this.canvas.height - this.BOUNDARY_MARGIN;

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

            if (dist < this.SEGMENT_SIZE + this.PIZZA_SIZE / 2) {
                // Ate pizza!
                this.pizzas.splice(i, 1);
                this.score++;
                this.spawnPizza();

                // Start swallowing animation
                this.swallowingPizzas.push({
                    segmentIndex: 0,
                    progress: 0
                });

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

        // Draw boundaries
        this.ctx.strokeStyle = '#FFF';
        this.ctx.lineWidth = 2;
        this.ctx.strokeRect(
            this.BOUNDARY_MARGIN,
            this.BOUNDARY_MARGIN,
            this.canvas.width - this.BOUNDARY_MARGIN * 2,
            this.canvas.height - this.BOUNDARY_MARGIN * 2
        );

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
        // Draw body segments with bulges
        this.ctx.fillStyle = '#4CAF50';
        for (let i = 1; i < this.snake.segments.length; i++) {
            const seg = this.snake.segments[i];

            // Check if there's a swallowing pizza at this segment
            let bulgeSize = this.SEGMENT_SIZE / 2;
            for (const swallow of this.swallowingPizzas) {
                if (Math.floor(swallow.segmentIndex) === i) {
                    // Create bulge effect - pizza makes segment bigger
                    const bulgeFactor = 1 + (this.PIZZA_SIZE / this.SEGMENT_SIZE) * 0.5;
                    bulgeSize = (this.SEGMENT_SIZE / 2) * bulgeFactor;
                }
            }

            this.ctx.beginPath();
            this.ctx.arc(seg.x, seg.y, bulgeSize, 0, Math.PI * 2);
            this.ctx.fill();

            // Draw pizza inside bulge
            for (const swallow of this.swallowingPizzas) {
                if (Math.floor(swallow.segmentIndex) === i) {
                    // Draw mini pizza
                    const pizzaSize = this.PIZZA_SIZE * 0.4;

                    this.ctx.fillStyle = '#D32F2F';
                    this.ctx.beginPath();
                    this.ctx.arc(seg.x, seg.y, pizzaSize / 2, 0, Math.PI * 2);
                    this.ctx.fill();

                    // Cheese triangles
                    this.ctx.fillStyle = '#FDD835';
                    for (let j = 0; j < 4; j++) {
                        const angle = (j / 4) * Math.PI * 2;
                        const x1 = seg.x + Math.cos(angle) * pizzaSize / 4;
                        const y1 = seg.y + Math.sin(angle) * pizzaSize / 4;
                        const x2 = seg.x + Math.cos(angle + Math.PI / 4) * pizzaSize / 3;
                        const y2 = seg.y + Math.sin(angle + Math.PI / 4) * pizzaSize / 3;

                        this.ctx.beginPath();
                        this.ctx.moveTo(seg.x, seg.y);
                        this.ctx.lineTo(x1, y1);
                        this.ctx.lineTo(x2, y2);
                        this.ctx.closePath();
                        this.ctx.fill();
                    }

                    // Reset to snake color
                    this.ctx.fillStyle = '#4CAF50';
                }
            }
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
        this.MOVE_SPEED = this.BASE_MOVE_SPEED * (value / 4);
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
